import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watchFile, unwatchFile } from 'node:fs';
import * as path from 'node:path';
import {
  spawn,
  ChildProcessWithoutNullStreams,
  execFile,
} from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import {
  CredentialCore,
  Message,
  Reply,
  Target,
  RecordValue,
  keyFor,
} from './core';
import { restoration, OwnedSettings } from './settings';
import { TESTED_SSH_SHA256 } from './compatibility';
import { parseHostIdentity, serverAddress } from './hostIdentity';
const execute = promisify(execFile);
const stateKey = 'ownedSettings.v1';
const indexKey = 'credentialIndex.v1';
type Metadata = Omit<RecordValue, 'password'>;
interface BridgeConfig {
  realSSHHash: string;
  realSSH: string;
  realSCP: string;
  enabled: boolean;
}
let runtime: Runtime | undefined;
const label = (t: Target) => t.user + '@' + serverAddress(t);
class ActionError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}
async function showProblem(
  message: string,
  detail: string,
  showDiagnostics: () => void,
): Promise<void> {
  const action: vscode.MessageItem = {
    title: vscode.l10n.t('Show Diagnostics'),
  };
  const selected = await vscode.window.showErrorMessage(
    message,
    { modal: true, detail },
    action,
  );
  if (selected === action) showDiagnostics();
}
function formatSavedTime(value: string): string {
  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return vscode.l10n.t('Unknown');
    return new Intl.DateTimeFormat(vscode.env.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return vscode.l10n.t('Unknown');
  }
}
async function atomicJSON(file: string, data: unknown) {
  const temp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temp, file);
}
class Runtime implements vscode.Disposable {
  private broker?: ChildProcessWithoutNullStreams;
  private core: CredentialCore;
  private output = vscode.window.createOutputChannel(
    vscode.l10n.t('SSH Password Memory'),
  );
  private activeUI = new Set<vscode.CancellationTokenSource>();
  private uiQueue: Promise<unknown> = Promise.resolve();
  private indexQueue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private watching = false;
  private enabled = false;
  private actions: Promise<unknown> = Promise.resolve();
  private restart?: NodeJS.Timeout;
  private bridgeDir: string;
  private route?: string;
  private previousRoute = process.env.SSHPM_WINDOW_PIPE;
  constructor(private context: vscode.ExtensionContext) {
    // This is not the extension installation directory. VS Code extension removal
    // leaves this persistent pass-through bridge in place for safe recovery.
    this.bridgeDir = path.join(context.globalStorageUri.fsPath, 'bridge-v1');
    this.core = new CredentialCore(
      context.secrets,
      {
        status: (event) => {
          const messages = {
            manual: vscode.l10n.t(
              'This authentication request cannot use a saved password. Enter the response manually for this connection.',
            ),
            missing: vscode.l10n.t(
              'No saved password matches this connection.',
            ),
            reused: vscode.l10n.t(
              'A saved password was supplied for this connection.',
            ),
            saved: vscode.l10n.t(
              'Password saved on this device after a successful sign-in.',
            ),
            rejected: vscode.l10n.t(
              'The server rejected the password. A rejected saved copy will not be used again.',
            ),
          };
          this.output.appendLine(messages[event]);
        },
        ask: (t, p, c, f, s) => this.input(t, p, c, f, s),
        trust: (t, p, f, s) => this.trust(t, p, f, s),
        changed: (t) => {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'The server fingerprint for {0} differs from the saved one. Automatic password entry is paused for this connection. Verify the server before signing in.',
              label(t),
            ),
          );
        },
        cancel: () => {},
      },
      (k, r) => this.updateIndex(k, r),
    );
    context.subscriptions.push(
      context.secrets.onDidChange((e) => {
        if (e.key.startsWith('revocation.v1.'))
          this.core.invalidate(e.key.slice('revocation.v1.'.length));
      }),
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remote.SSH.path'))
          void this.command(() => this.reconcile()).catch(() => {});
      }),
    );
  }
  private updateIndex(key: string, record?: Metadata): Promise<void> {
    const work = this.indexQueue.then(async () => {
      const index = {
        ...this.context.globalState.get<Record<string, Metadata>>(indexKey, {}),
      };
      if (record) index[key] = record;
      else delete index[key];
      await this.context.globalState.update(indexKey, index);
    });
    this.indexQueue = work.catch(() => {});
    return work;
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const p = this.uiQueue.then(task);
    this.uiQueue = p.catch(() => {});
    return p;
  }
  private input(
    t: Target,
    prompt: string,
    cacheable: boolean,
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<Reply> {
    return this.serial(async () => {
      if (!this.enabled || signal?.aborted) return { canceled: true };
      const token = new vscode.CancellationTokenSource();
      this.activeUI.add(token);
      const abort = () => token.cancel();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const value = await vscode.window.showInputBox(
          {
            title: cacheable
              ? vscode.l10n.t('SSH password · {0}', label(t))
              : vscode.l10n.t('SSH verification · {0}', label(t)),
            prompt: cacheable
              ? failed
                ? vscode.l10n.t('The server rejected the password. Try again.')
                : vscode.l10n.t(
                    'You can choose whether to remember this password in the next step.',
                  )
              : vscode.l10n.t(
                  'This response is used for this connection only and will not be saved.',
                ),
            placeHolder: cacheable
              ? vscode.l10n.t('Enter server password')
              : vscode.l10n.t(
                  'Authentication request: {0}',
                  prompt.slice(0, 500),
                ),
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) =>
              !v
                ? vscode.l10n.t('Enter a response to continue.')
                : /[\r\n\x00]/.test(v)
                  ? vscode.l10n.t(
                      'Line breaks and null characters are not allowed.',
                    )
                  : Buffer.byteLength(v, 'utf8') > 8192
                    ? vscode.l10n.t(
                        'The input is too long. Use no more than 8192 bytes.',
                      )
                    : undefined,
          },
          token.token,
        );
        if (value === undefined || signal?.aborted || !this.enabled)
          return { canceled: true };
        if (!cacheable) return { value, remember: false, source: 'input' };
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: vscode.l10n.t('Remember on This Device'),
              remember: true,
              description: vscode.l10n.t(
                'Save after a successful sign-in; fill automatically next time',
              ),
            },
            {
              label: vscode.l10n.t('Use Once'),
              remember: false,
              description: vscode.l10n.t('Do not save; ask again next time'),
            },
          ],
          {
            title: vscode.l10n.t('Password for {0}', label(t)),
            placeHolder: vscode.l10n.t(
              'Choose whether to remember this password',
            ),
            ignoreFocusOut: true,
          },
          token.token,
        );
        return choice
          ? { value, remember: choice.remember, source: 'input' }
          : { canceled: true };
      } finally {
        signal?.removeEventListener('abort', abort);
        this.activeUI.delete(token);
        token.dispose();
      }
    });
  }
  private trust(
    t: Target,
    prompt: string,
    fingerprint: string | undefined,
    signal?: AbortSignal,
  ): Promise<Reply> {
    return this.serial(async () => {
      if (!this.enabled || signal?.aborted) return { canceled: true };
      const identity = parseHostIdentity(prompt, fingerprint);
      const server = vscode.l10n.t('Server: {0}', serverAddress(t));
      const detail = identity
        ? [
            vscode.l10n.t(
              'The server identity needs confirmation for this connection.',
            ),
            '',
            server,
            vscode.l10n.t('Key type: {0}', identity.keyType),
            vscode.l10n.t('Fingerprint:\n{0}', identity.fingerprint),
            '',
            vscode.l10n.t(
              'Compare this fingerprint with one provided by your administrator. Continue only if they match.',
            ),
            vscode.l10n.t('If you are unsure, cancel the connection.'),
          ].join('\n')
        : [
            server,
            '',
            vscode.l10n.t(
              'Original OpenSSH request:\n{0}',
              prompt.slice(0, 8192),
            ),
            '',
            vscode.l10n.t(
              'Review the SSH request before continuing. Cancel if you are unsure.',
            ),
          ].join('\n');
      const yes = await vscode.window.showWarningMessage(
        identity
          ? vscode.l10n.t('Trust this server?')
          : vscode.l10n.t('Review the SSH confirmation'),
        { modal: true, detail },
        identity
          ? vscode.l10n.t('Trust and Connect')
          : vscode.l10n.t('Continue Connection'),
      );
      return yes && this.enabled && !signal?.aborted
        ? { value: 'yes' }
        : { canceled: true };
    });
  }
  private config() {
    return vscode.workspace.getConfiguration('remote.SSH');
  }
  private async bridgeConfig(): Promise<BridgeConfig | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.bridgeDir, 'bridge.json'), 'utf8'),
      );
    } catch {
      return undefined;
    }
  }
  command<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.actions.then(work);
    this.actions = next.catch(() => {});
    return next;
  }
  private async reconcile() {
    if (this.stopping) return;
    const cfg = await this.bridgeConfig();
    const ownsPath =
      this.config().get<string>('path') ===
      path.join(this.bridgeDir, 'ssh.exe');
    if (cfg?.enabled && ownsPath) {
      this.enabled = true;
      await this.launch();
    } else if (this.enabled) {
      this.enabled = false;
      this.stopBroker();
      this.core.clear();
    }
  }
  async start() {
    if (process.platform !== 'win32' || process.arch !== 'x64') return;
    if (!this.watching) {
      this.watching = true;
      watchFile(
        path.join(this.bridgeDir, 'bridge.json'),
        { interval: 1000, persistent: false },
        () => {
          void this.command(() => this.reconcile()).catch(() => {});
        },
      );
    }
    await this.reconcile();
  }
  private async launch() {
    if (this.broker || !this.enabled || this.stopping) return;
    const broker = spawn(path.join(this.bridgeDir, 'broker.exe'), [], {
      windowsHide: true,
      stdio: 'pipe',
    });
    this.broker = broker;
    let readyResolve!: () => void;
    const ready = new Promise<void>((r) => (readyResolve = r));
    const timer = setTimeout(readyResolve, 5000);
    const lines = createInterface({ input: broker.stdout });
    let healthy = false;
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 65536) {
        broker.kill();
        return;
      }
      let m: Message;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === 'ready') {
        healthy = true;
        this.route = m.prompt;
        process.env.SSHPM_WINDOW_PIPE = m.prompt;
        clearTimeout(timer);
        readyResolve();
        this.output.appendLine(
          vscode.l10n.t('The local authentication service is ready.'),
        );
        return;
      }
      if (m.type === 'end') {
        void this.core.handle(m);
        return;
      }
      void this.core
        .handle(m)
        .then((reply) => {
          if (!this.enabled) reply = { canceled: true };
          if (broker.stdin.writable)
            broker.stdin.write(
              JSON.stringify({ id: m.id, type: 'answer', reply }) + '\n',
            );
        })
        .catch(() => {
          if (broker.stdin.writable)
            broker.stdin.write(
              JSON.stringify({
                id: m.id,
                type: 'answer',
                reply: { canceled: true },
              }) + '\n',
            );
          this.output.appendLine(
            vscode.l10n.t(
              'Could not access saved passwords. Reconnect and try again.',
            ),
          );
        });
    });
    broker.stdin.on('error', () => {});
    broker.stderr.on('data', () => {
      this.output.appendLine(
        vscode.l10n.t('The local authentication service reported an error.'),
      );
    });
    broker.on('error', () => {
      clearTimeout(timer);
      readyResolve();
      this.output.appendLine(
        vscode.l10n.t(
          'Could not start the local authentication service. Disable password memory, then enable it again.',
        ),
      );
    });
    broker.on('exit', () => {
      clearTimeout(timer);
      readyResolve();
      lines.close();
      if (this.broker !== broker) return;
      this.broker = undefined;
      this.core.clear();
      for (const token of this.activeUI) token.cancel();
      if (!this.stopping && this.enabled && healthy)
        this.restart = setTimeout(
          () =>
            void this.launch().catch(() =>
              this.output.appendLine(
                vscode.l10n.t(
                  'Could not restart the local authentication service. Disable password memory, then enable it again.',
                ),
              ),
            ),
          1500,
        );
    });
    await ready;
    if (!healthy) {
      this.stopBroker();
      throw new ActionError(
        vscode.l10n.t('Could not start the authentication service'),
        vscode.l10n.t('Disable password memory, then enable it again.'),
      );
    }
  }
  async enable() {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      await vscode.window.showErrorMessage(
        vscode.l10n.t('This extension requires local VS Code on Windows x64.'),
      );
      return;
    }
    const previous = this.context.globalState.get<OwnedSettings>(stateKey);
    if (previous) {
      const current = await this.bridgeConfig();
      if (
        current?.enabled &&
        this.config().get<string>('path') === previous.bridgePath
      ) {
        await this.start();
        await vscode.window.showInformationMessage(
          vscode.l10n.t('Password memory is already on.'),
        );
        return;
      }
      await this.disable(false);
    }
    const cfg = this.config();
    const original = {
      path: cfg.inspect<string>('path')?.globalValue,
      useLocalServer: cfg.inspect<boolean>('useLocalServer')?.globalValue,
    };
    let realSSH =
      original.path ||
      path.join(
        process.env.WINDIR || 'C:\\Windows',
        'System32',
        'OpenSSH',
        'ssh.exe',
      );
    if (
      path.resolve(path.dirname(realSSH)).toLowerCase() ===
      path.resolve(this.bridgeDir).toLowerCase()
    )
      realSSH = path.join(
        process.env.WINDIR || 'C:\\Windows',
        'System32',
        'OpenSSH',
        'ssh.exe',
      );
    const realSCP = path.join(path.dirname(realSSH), 'scp.exe');
    try {
      const version = await execute(realSSH, ['-V'], {
        windowsHide: true,
        timeout: 5000,
      });
      if (
        !(version.stderr + version.stdout).includes(
          'OpenSSH_for_Windows_9.5p2',
        ) ||
        createHash('sha256')
          .update(await fs.readFile(realSSH))
          .digest('hex') !== TESTED_SSH_SHA256
      )
        throw new Error('unsupported');
      await fs.access(realSCP);
    } catch {
      await showProblem(
        vscode.l10n.t('Could not enable password memory'),
        [
          vscode.l10n.t(
            'The SSH program is missing, unsupported, or does not have scp.exe beside it.',
          ),
          vscode.l10n.t('SSH program: {0}', realSSH),
          '',
          vscode.l10n.t(
            'This preview requires the OpenSSH 9.5p2 build listed in the compatibility guide.',
          ),
          vscode.l10n.t('Password memory was not enabled.'),
        ].join('\n'),
        () => this.diagnostics(),
      );
      return;
    }
    const accepted = await vscode.window.showInformationMessage(
      vscode.l10n.t('Enable SSH password memory?'),
      {
        modal: true,
        detail: [
          vscode.l10n.t('Keep using Remote-SSH to connect to your servers.'),
          '',
          vscode.l10n.t('User settings to change:'),
          vscode.l10n.t("remote.SSH.path → this extension's local SSH helper"),
          vscode.l10n.t('remote.SSH.useLocalServer → true'),
          '',
          vscode.l10n.t(
            'Passwords you choose to remember are saved locally in encrypted storage after a successful sign-in.',
          ),
          vscode.l10n.t(
            'You confirm server fingerprints yourself. Server notices shown before authentication are hidden while password memory is on.',
          ),
          '',
          vscode.l10n.t(
            'The local SSH helper stays on this device after disabling or uninstalling, to support ordinary SSH connections.',
          ),
        ].join('\n'),
      },
      vscode.l10n.t('Enable Password Memory'),
    );
    if (!accepted) return;
    await fs.mkdir(this.bridgeDir, { recursive: true });
    await execute(
      path.join(this.context.extensionPath, 'bin', 'broker.exe'),
      ['--secure-directory', this.bridgeDir],
      { windowsHide: true, timeout: 5000 },
    );
    for (const file of ['ssh.exe', 'scp.exe', 'askpass.exe', 'broker.exe']) {
      const source = path.join(this.context.extensionPath, 'bin', file),
        dest = path.join(this.bridgeDir, file);
      const bytes = await fs.readFile(source);
      let same = false;
      try {
        same = bytes.equals(await fs.readFile(dest));
      } catch {}
      if (!same) await fs.copyFile(source, dest);
    }
    await atomicJSON(path.join(this.bridgeDir, 'bridge.json'), {
      realSSH,
      realSCP,
      realSSHHash: createHash('sha256')
        .update(await fs.readFile(realSSH))
        .digest('hex'),
      enabled: true,
    });
    const owned: OwnedSettings = {
      original,
      bridgePath: path.join(this.bridgeDir, 'ssh.exe'),
    };
    // Journal first: activation/disable can recover an interrupted settings update.
    await this.context.globalState.update(stateKey, owned);
    await atomicJSON(path.join(this.bridgeDir, 'recovery.json'), owned);
    this.enabled = true;
    try {
      await this.launch();
      await cfg.update(
        'path',
        owned.bridgePath,
        vscode.ConfigurationTarget.Global,
      );
      await cfg.update(
        'useLocalServer',
        true,
        vscode.ConfigurationTarget.Global,
      );
    } catch {
      await this.disable(false);
      throw new ActionError(
        vscode.l10n.t('Could not update SSH settings'),
        vscode.l10n.t(
          'Automatic recovery was attempted. Check remote.SSH.path in your user settings before trying again.',
        ),
      );
    }
    await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Password memory is on. Connect to a host with Remote-SSH.',
      ),
    );
  }
  async disable(notify = true) {
    this.enabled = false;
    this.stopBroker();
    this.core.clear();
    const bridge = await this.bridgeConfig();
    if (bridge)
      await atomicJSON(path.join(this.bridgeDir, 'bridge.json'), {
        ...bridge,
        enabled: false,
      });
    const owned = this.context.globalState.get<OwnedSettings>(stateKey);
    if (owned) {
      const cfg = this.config();
      const changes = restoration(
        {
          path: cfg.inspect<string>('path')?.globalValue,
          useLocalServer: cfg.inspect<boolean>('useLocalServer')?.globalValue,
        },
        owned,
      );
      for (const [k, v] of Object.entries(changes))
        await cfg.update(k, v.value, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(stateKey, undefined);
      this.output.appendLine(
        vscode.l10n.t(
          'Connection settings were restored unless you had changed them manually.',
        ),
      );
    }
    if (notify)
      await vscode.window.showInformationMessage(
        vscode.l10n.t('Password memory is off. Saved passwords are kept.'),
      );
  }
  async manage() {
    const index: Record<string, Metadata> = {};
    for (const key of await this.context.secrets.keys()) {
      if (!key.startsWith('credential.v1.')) continue;
      try {
        const r = JSON.parse(
          (await this.context.secrets.get(key)) || 'null',
        ) as RecordValue;
        if (r?.target && keyFor(r.target) === key) {
          const valid = await this.core.read(r.target);
          if (valid) {
            const { password, ...meta } = valid;
            index[key] = meta;
          }
        }
      } catch {}
    }
    const items = Object.values(index).map((r) => ({
      label: label(r.target),
      description: r.fingerprint,
      detail: vscode.l10n.t('Last sign-in: {0}', formatSavedTime(r.updated)),
      record: r,
    }));
    if (!items.length) {
      await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'No saved passwords yet. Choose Remember on This Device when you connect.',
        ),
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Saved Passwords'),
      placeHolder: vscode.l10n.t(
        'Select a connection to delete its saved password',
      ),
      matchOnDescription: true,
    });
    if (!selected) return;
    if (
      await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete this saved password?'),
        {
          modal: true,
          detail: [
            vscode.l10n.t('Connection: {0}', selected.label),
            vscode.l10n.t(
              'Only the saved copy on this device will be removed. Your server password will stay the same.',
            ),
          ].join('\n\n'),
        },
        vscode.l10n.t('Delete Password'),
      )
    ) {
      await this.core.forget(selected.record.target);
      await vscode.window.showInformationMessage(
        vscode.l10n.t('Saved password deleted.'),
      );
    }
  }
  diagnostics() {
    this.output.appendLine(vscode.l10n.t('VS Code: {0}', vscode.version));
    this.output.appendLine(
      vscode.l10n.t('Platform: {0}/{1}', process.platform, process.arch),
    );
    this.output.appendLine(
      vscode.l10n.t(
        'Password memory: {0}',
        this.enabled ? vscode.l10n.t('on') : vscode.l10n.t('off'),
      ),
    );
    this.output.appendLine(
      vscode.l10n.t(
        'Authentication service: {0}',
        this.broker ? vscode.l10n.t('running') : vscode.l10n.t('not running'),
      ),
    );
    this.output.appendLine(
      vscode.l10n.t('Local SSH helper folder: {0}', this.bridgeDir),
    );
    this.output.appendLine(
      vscode.l10n.t(
        'Only SSH password authentication can be remembered. Verification codes, interactive challenges, and key passphrases must be entered each time.',
      ),
    );
    this.output.show();
  }
  private stopBroker() {
    if (process.env.SSHPM_WINDOW_PIPE === this.route) {
      if (this.previousRoute === undefined)
        delete process.env.SSHPM_WINDOW_PIPE;
      else process.env.SSHPM_WINDOW_PIPE = this.previousRoute;
    }
    this.route = undefined;
    if (this.restart) clearTimeout(this.restart);
    for (const t of this.activeUI) t.cancel();
    const b = this.broker;
    this.broker = undefined;
    b?.stdin.end();
    setTimeout(() => b?.kill(), 1000).unref();
  }
  dispose() {
    if (this.stopping) return;
    unwatchFile(path.join(this.bridgeDir, 'bridge.json'));
    this.stopping = true;
    this.stopBroker();
    this.core.clear();
    this.output.dispose();
  }
}
export async function activate(context: vscode.ExtensionContext) {
  runtime = new Runtime(context);
  context.subscriptions.push(runtime);
  const run = (f: () => Promise<unknown> | void) => async () => {
    try {
      await runtime!.command(f);
    } catch (error) {
      await showProblem(
        error instanceof ActionError
          ? error.message
          : vscode.l10n.t('Could not complete this action'),
        error instanceof ActionError
          ? error.detail
          : vscode.l10n.t(
              'Run Show Diagnostics from the Command Palette, then try again.',
            ),
        () => runtime!.diagnostics(),
      );
    }
  };
  for (const [name, fn] of Object.entries({
    enable: () => runtime!.enable(),
    disable: () => runtime!.disable(),
    manage: () => runtime!.manage(),
    forget: () => runtime!.manage(),
    diagnostics: () => runtime!.diagnostics(),
  }))
    context.subscriptions.push(
      vscode.commands.registerCommand('sshPasswordMemory.' + name, run(fn)),
    );
  await runtime.start().catch(() => runtime!.diagnostics());
}
export function deactivate() {
  runtime?.dispose();
  runtime = undefined;
}
