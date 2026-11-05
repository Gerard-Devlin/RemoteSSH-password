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
const label = (t: Target) => t.user + '@' + t.host + ':' + t.port;
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
  private output = vscode.window.createOutputChannel('SSH Password Memory');
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
        ask: (t, p, c, f, s) => this.input(t, p, c, f, s),
        trust: (t, p, f, s) => this.trust(t, p, f, s),
        changed: (t) => {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'SSH Password Memory: the host fingerprint for {0} differs from the saved record. Automatic password filling has stopped. Verify the server before continuing.',
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
            title: vscode.l10n.t('SSH Password Memory · {0}', label(t)),
            prompt: cacheable
              ? failed
                ? vscode.l10n.t(
                    'The server rejected the previous password. Enter a new password.',
                  )
                : vscode.l10n.t(
                    'Enter the server password. It will only be saved after successful authentication.',
                  )
              : vscode.l10n.t(
                  'Complete the server authentication step. This response will not be saved.',
                ),
            placeHolder: cacheable
              ? vscode.l10n.t('Enter server password')
              : vscode.l10n.t('Server request: {0}', prompt.slice(0, 500)),
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) =>
              !v
                ? vscode.l10n.t('Enter a value.')
                : /[\r\n\x00]/.test(v) || Buffer.byteLength(v, 'utf8') > 8192
                  ? vscode.l10n.t(
                      'Newlines, NUL characters, and answers longer than 8192 bytes are not supported.',
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
                'Save to VS Code encrypted storage only after successful authentication',
              ),
            },
            {
              label: vscode.l10n.t('Use Once'),
              remember: false,
              description: vscode.l10n.t('Ask again on the next connection'),
            },
          ],
          {
            title: vscode.l10n.t(
              'How should the password for {0} be used?',
              label(t),
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
            vscode.l10n.t('This server is not yet trusted on this device.'),
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
              'Review the server request before continuing. Cancel if you are unsure.',
            ),
          ].join('\n');
      const yes = await vscode.window.showWarningMessage(
        identity
          ? vscode.l10n.t('Trust this server?')
          : vscode.l10n.t('Review the SSH confirmation'),
        { modal: true, detail },
        vscode.l10n.t('Trust and Connect'),
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
          vscode.l10n.t(
            'Local authentication broker is ready (answers are never logged).',
          ),
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
              'Credential operation failed. This authentication answer was canceled.',
            ),
          );
        });
    });
    broker.stdin.on('error', () => {});
    broker.stderr.on('data', () => {
      this.output.appendLine(
        vscode.l10n.t(
          'The native broker reported an error; raw contents were not logged.',
        ),
      );
    });
    broker.on('error', () => {
      clearTimeout(timer);
      readyResolve();
      this.output.appendLine(
        vscode.l10n.t(
          'Could not start the local broker. Enable password memory again.',
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
                  'Broker restart failed. Disable password memory, then enable it again.',
                ),
              ),
            ),
          1500,
        );
    });
    await ready;
    if (!healthy) {
      this.stopBroker();
      throw new Error('Broker did not become ready');
    }
  }
  async enable() {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'This preview only supports local VS Code on Windows x64.',
        ),
      );
      return;
    }
    if (this.context.globalState.get<OwnedSettings>(stateKey)) {
      await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'An existing setup was found. To change the real SSH executable, disable password memory before enabling it again.',
        ),
      );
      const current = await this.bridgeConfig();
      if (current?.enabled) {
        await this.start();
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
      await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'This OpenSSH build is unsupported, or scp.exe is missing. The preview requires the Windows OpenSSH 9.5p2 SHA256 listed in the compatibility guide. Settings were not changed.',
        ),
      );
      return;
    }
    const accepted = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Only the user settings remote.SSH.path and remote.SSH.useLocalServer will change. Passwords use VS Code SecretStorage; server fingerprints are never accepted automatically. Managed connections hide pre-authentication server banners to prevent spoofed authentication signals. A persistent bridge remains after disabling or uninstalling for ordinary SSH fallback.',
      ),
      { modal: true },
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
      throw new Error(
        vscode.l10n.t(
          'Could not update user settings; recovery was attempted.',
        ),
      );
    }
    await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Password memory is enabled. Connect through Remote-SSH as usual; enter the first password only in VS Code.',
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
    }
    if (notify)
      await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Password memory is disabled. Settings still owned by this extension were restored. Saved passwords are retained; use Forget Password to delete them.',
        ),
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
      detail: vscode.l10n.t('Successfully authenticated: {0}', r.updated),
      record: r,
    }));
    if (!items.length) {
      await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'No saved credentials yet. Credentials appear here only after choosing Remember on This Device and authenticating successfully.',
        ),
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t(
        'Saved credentials (select to delete; passwords are never displayed)',
      ),
      matchOnDescription: true,
    });
    if (!selected) return;
    if (
      await vscode.window.showWarningMessage(
        vscode.l10n.t('Forget the password for {0}?', selected.label),
        { modal: true },
        vscode.l10n.t('Forget Password'),
      )
    ) {
      await this.core.forget(selected.record.target);
      await vscode.window.showInformationMessage(
        vscode.l10n.t('Password forgotten.'),
      );
    }
  }
  diagnostics() {
    this.output.appendLine(
      vscode.l10n.t(
        'Platform: {0}/{1}; VS Code: {2}',
        process.platform,
        process.arch,
        vscode.version,
      ),
    );
    this.output.appendLine(
      vscode.l10n.t(
        'Broker: {0}; password memory: {1}',
        this.broker ? vscode.l10n.t('running') : vscode.l10n.t('not running'),
        this.enabled ? vscode.l10n.t('enabled') : vscode.l10n.t('disabled'),
      ),
    );
    this.output.appendLine(
      vscode.l10n.t('Persistent bridge: {0}', this.bridgeDir),
    );
    this.output.appendLine(
      vscode.l10n.t(
        'Only the SSH password method can be remembered. Keyboard-interactive, OTP, and key passphrases require manual input and are not saved.',
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
    } catch {
      await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'SSH Password Memory could not complete the operation. Check diagnostics or restore remote.SSH.path using the troubleshooting guide. Authentication contents were not logged.',
        ),
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
