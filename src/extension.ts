import { executableName, supportedPlatform } from './platform';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import * as path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  CredentialCore,
  Message,
  Reply,
  Target,
  RecordValue,
  keyFor,
} from './core';
import { OwnedSettings } from './settings';
import { SetupManager } from './setup';
import { parseHostIdentity, serverAddress } from './hostIdentity';
const stateKey = 'ownedSettings.v1';
const indexKey = 'credentialIndex.v1';
type Metadata = Omit<RecordValue, 'password'>;
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
  private setup?: SetupManager;
  private setupAttempts = 0;
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
        ask: (t, p, c, f, s, m) => this.input(t, p, c, f, s, m),
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
        if (
          e.affectsConfiguration('remote.SSH.path') ||
          e.affectsConfiguration('remote.SSH.useLocalServer')
        )
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
    method?: string,
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
                  'This verification request cannot be remembered. Enter a response for this connection.',
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
              description:
                method === 'keyboard-interactive'
                  ? vscode.l10n.t(
                      'For your fixed server password; never choose this for a verification code',
                    )
                  : vscode.l10n.t(
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
  command<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.actions.then(work);
    this.actions = next.catch(() => {});
    return next;
  }
  private async initializeSetup() {
    if (this.setup) return;
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(this.context.extensionPath, 'package.json'),
        'utf8',
      ),
    );
    this.setup = new SetupManager({
      storage: this.context.globalStorageUri.fsPath,
      extensionPath: this.context.extensionPath,
      version: manifest.version,
      legacyOwned: this.context.globalState.get<OwnedSettings>(stateKey),
      adapter: {
        read: () => ({
          path: this.config().inspect<string>('path')?.globalValue,
          useLocalServer:
            this.config().inspect<boolean>('useLocalServer')?.globalValue,
        }),
        effectivePath: () => this.config().get<string>('path'),
        write: async (key, value) => {
          await this.config().update(
            key,
            value,
            vscode.ConfigurationTarget.Global,
          );
        },
        start: async (directory) => {
          if (directory !== this.bridgeDir) {
            this.stopBroker();
            this.core.clear();
          }
          this.bridgeDir = directory;
          this.enabled = true;
          await this.launch();
        },
        stop: () => {
          this.enabled = false;
          this.stopBroker();
          this.core.clear();
        },
      },
    });
  }
  setupFailed() {
    this.output.appendLine(
      vscode.l10n.t(
        'Password memory could not start automatically. Reload the local VS Code window or check diagnostics.',
      ),
    );
    if (!this.stopping && this.setupAttempts < 3) {
      const delay = 1000 * 2 ** this.setupAttempts++;
      if (this.restart) clearTimeout(this.restart);
      this.restart = setTimeout(
        () =>
          void this.command(() => this.reconcile()).catch(() =>
            this.setupFailed(),
          ),
        delay,
      );
    }
  }
  private async reconcile() {
    if (this.stopping || !this.setup) return;
    await this.setup.ensure();
  }
  async start() {
    if (!supportedPlatform()) return;
    await this.initializeSetup();
    if (!this.watching) {
      this.watching = true;
      watchFile(
        this.setup!.controlPath,
        { interval: 500, persistent: false },
        () => {
          void this.command(() => this.reconcile()).catch(() =>
            this.setupFailed(),
          );
        },
      );
    }
    await this.command(() => this.reconcile()).catch(() => this.setupFailed());
  }
  private async launch() {
    if (this.broker || !this.enabled || this.stopping) return;
    const broker = spawn(
      path.join(this.bridgeDir, executableName('broker')),
      [],
      {
        windowsHide: true,
        stdio: 'pipe',
      },
    );
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
          'Could not start the local authentication service. Reload the local VS Code window and reconnect.',
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
            void this.reconcile().catch(() =>
              this.output.appendLine(
                vscode.l10n.t(
                  'Could not restart the local authentication service. Reload the local VS Code window and reconnect.',
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
        vscode.l10n.t('Reload the local VS Code window and reconnect.'),
      );
    }
  }
  async enable() {
    if (!supportedPlatform()) {
      await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'This extension requires local VS Code on Windows x64 or macOS (Apple Silicon or Intel).',
        ),
      );
      return;
    }
    await this.initializeSetup();
    const status = await this.setup!.ensure(true);
    if (status !== 'ready')
      throw new ActionError(
        vscode.l10n.t('Could not start the authentication service'),
        vscode.l10n.t('Reload the local VS Code window and reconnect.'),
      );
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Password memory is on. Connect to a host with Remote-SSH.',
      ),
    );
  }
  async disable(notify = true) {
    await this.initializeSetup();
    await this.setup!.disable();
    if (notify)
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Password memory is off. Saved passwords are kept.'),
      );
  }
  async manage() {
    const index: Record<string, Metadata> = {};
    const storage = this.context.secrets as vscode.SecretStorage & {
      keys?: () => Thenable<string[]>;
    };
    const keys = storage.keys
      ? await storage.keys()
      : Object.keys(
          this.context.globalState.get<Record<string, Metadata>>(indexKey, {}),
        );
    for (const key of keys) {
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
        'Password memory starts automatically. Fixed passwords can be remembered; verification codes and key passphrases are entered each time.',
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
    if (this.setup) unwatchFile(this.setup.controlPath);
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
  await runtime.start().catch(() => runtime!.setupFailed());
}
export function deactivate() {
  runtime?.dispose();
  runtime = undefined;
}
