import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TESTED_SSH_SHA256 } from './compatibility';
import { defaultSSH, executableName } from './platform';
import {
  SettingSnapshot,
  OwnedSettings,
  managedBridgeDirectory,
  selectSSHSettings,
  restoration,
} from './settings';
const execute = promisify(execFile);
const same = (a?: string, b?: string) =>
  a === b ||
  (!!a &&
    !!b &&
    (process.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b)));
const equal = (a: SettingSnapshot, b: SettingSnapshot) =>
  same(a.path, b.path) && a.useLocalServer === b.useLocalServer;
const versionOrder = (a: string, b: string) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
interface Control {
  version: string;
  enabled: boolean;
  status: 'pending' | 'ready' | 'suspended';
  revision: string;
  managedPath?: string;
  original?: SettingSnapshot;
  before?: SettingSnapshot;
}
export interface SetupOptions {
  platform?: NodeJS.Platform;
  storage: string;
  extensionPath: string;
  version: string;
  legacyOwned?: OwnedSettings;
  adapter: {
    read(): SettingSnapshot;
    effectivePath(): string | undefined;
    write(
      key: 'path' | 'useLocalServer',
      value: string | boolean | undefined,
    ): Promise<void>;
    start(directory: string): Promise<void>;
    stop(): void;
  };
  validateSSH?: (ssh: string) => Promise<void>;
  secureDirectory?: (directory: string) => Promise<void>;
}
export class SetupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class SetupManager {
  readonly controlPath: string;
  private get platform() {
    return this.options.platform ?? process.platform;
  }
  private file(name: string) {
    return executableName(name, this.platform);
  }
  constructor(private options: SetupOptions) {
    this.controlPath = path.join(options.storage, 'control-v2.json');
  }
  private async read(file: string): Promise<any> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }
  private async write(file: string, value: unknown) {
    const temp = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, file);
  }
  private inside(file: string) {
    const relative = path.relative(this.options.storage, path.resolve(file));
    return (
      !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    );
  }
  private async control(): Promise<Control | undefined> {
    const c = await this.read(this.controlPath);
    if (!c) return;
    if (
      typeof c.enabled !== 'boolean' ||
      !/^\d+\.\d+\.\d+$/.test(c.version) ||
      !['pending', 'ready', 'suspended'].includes(c.status) ||
      (c.managedPath &&
        (!this.inside(c.managedPath) ||
          path.basename(c.managedPath) !== this.file('ssh')))
    )
      throw new SetupError('invalid-state');
    return c;
  }
  private async secure(directory: string) {
    if (this.options.secureDirectory)
      return this.options.secureDirectory(directory);
    if (this.platform === 'darwin') {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.())
        throw new SetupError('invalid-deployment');
      await fs.chmod(directory, 0o700);
      return;
    }
    await execute(
      path.join(this.options.extensionPath, 'bin', this.file('broker')),
      ['--secure-directory', directory],
      { windowsHide: true, timeout: 5000 },
    );
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.options.storage, { recursive: true });
    await this.secure(this.options.storage);
    const lock = path.join(this.options.storage, 'setup.lock'),
      token = randomUUID();
    let handle: fs.FileHandle | undefined;
    const deadline = Date.now() + 10000;
    while (!handle) {
      try {
        handle = await fs.open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (handle) {
            await handle.close();
            await fs.unlink(lock).catch(() => {});
          }
          throw e;
        }
        const old = await this.read(lock);
        if (Number.isInteger(old?.pid)) {
          let dead = false;
          try {
            process.kill(old.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (dead && (await this.read(lock))?.token === old.token) {
            await fs.unlink(lock).catch(() => {});
            continue;
          }
        }
        if (Date.now() > deadline) throw new SetupError('busy');
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    try {
      return await work();
    } finally {
      await handle.close();
      if ((await this.read(lock))?.token === token)
        await fs.unlink(lock).catch(() => {});
    }
  }
  private async validate(realSSH: string) {
    if (this.options.validateSSH) return this.options.validateSSH(realSSH);
    try {
      const hash = createHash('sha256')
        .update(await fs.readFile(realSSH))
        .digest('hex');
      if (this.platform === 'win32' && hash !== TESTED_SSH_SHA256)
        throw new Error();
      const version = await execute(realSSH, ['-V'], {
        windowsHide: true,
        timeout: 5000,
      });
      const label = version.stdout + version.stderr;
      if (this.platform === 'win32') {
        if (!label.includes('OpenSSH_for_Windows_9.5p2')) throw new Error();
      } else {
        const match = /^OpenSSH_(\d+)\.(\d+)p\d+/m.exec(label);
        if (!match || Number(match[1]) < 9) throw new Error();
        await execute(
          realSSH,
          [
            '-G',
            '-F',
            '/dev/null',
            '-o',
            'LogVerbose=*:read_passphrase():*',
            'localhost',
          ],
          { timeout: 5000 },
        );
      }
      await fs.access(path.join(path.dirname(realSSH), this.file('scp')));
    } catch {
      throw new SetupError('unsupported-ssh');
    }
  }
  async ensure(
    force = false,
  ): Promise<'ready' | 'disabled' | 'suspended' | 'outdated'> {
    return this.locked(async () => {
      let state = await this.control();
      const adapter = this.options.adapter,
        current = adapter.read();
      if (state && versionOrder(state.version, this.options.version) > 0) {
        adapter.stop();
        return 'outdated';
      }
      if (!force && state && (!state.enabled || state.status === 'suspended')) {
        adapter.stop();
        return state.enabled ? 'suspended' : 'disabled';
      }
      if (
        !state &&
        !force &&
        (
          await this.read(
            path.join(this.options.storage, 'bridge-v1', 'bridge.json'),
          )
        )?.enabled === false
      ) {
        await this.write(this.controlPath, {
          version: this.options.version,
          enabled: false,
          status: 'ready',
          revision: randomUUID(),
        });
        adapter.stop();
        return 'disabled';
      }
      if (
        !force &&
        state?.enabled &&
        state.status === 'ready' &&
        (!same(current.path, state.managedPath) ||
          current.useLocalServer !== true)
      ) {
        await this.write(this.controlPath, {
          ...state,
          status: 'suspended',
          revision: randomUUID(),
        });
        adapter.stop();
        return 'suspended';
      }
      if (
        !force &&
        state?.status === 'pending' &&
        !same(current.path, state.managedPath) &&
        state.before &&
        !equal(current, state.before)
      ) {
        await this.write(this.controlPath, {
          ...state,
          status: 'suspended',
          revision: randomUUID(),
        });
        adapter.stop();
        return 'suspended';
      }
      const effective = adapter.effectivePath();
      if (effective && !same(effective, current.path)) {
        adapter.stop();
        return 'suspended';
      }
      const legacy = path.join(
        path.dirname(this.options.storage),
        'local-tools.remote-ssh-password-memory',
        'bridge-v1',
      );
      const directories = [
        path.join(this.options.storage, 'bridge-v1'),
        legacy,
      ];
      if (state?.managedPath) directories.push(path.dirname(state.managedPath));
      if (
        this.options.legacyOwned?.bridgePath &&
        this.inside(this.options.legacyOwned.bridgePath)
      )
        directories.push(path.dirname(this.options.legacyOwned.bridgePath));
      const previous = managedBridgeDirectory(
        current.path,
        directories,
        this.platform,
      );
      let recovery = previous
        ? await this.read(path.join(previous, 'recovery.json'))
        : undefined;
      if (state?.managedPath && same(state.managedPath, current.path))
        recovery = { bridgePath: state.managedPath, original: state.original };
      if (
        !recovery &&
        this.options.legacyOwned &&
        same(current.path, this.options.legacyOwned.bridgePath)
      )
        recovery = this.options.legacyOwned;
      const selection = selectSSHSettings(
        current,
        defaultSSH(this.platform),
        directories,
        recovery,
        previous
          ? await this.read(path.join(previous, 'bridge.json'))
          : undefined,
        this.platform,
      );
      await this.validate(selection.realSSH);
      const files = ['ssh', 'scp', 'askpass', 'broker'].map((name) =>
        this.file(name),
      );
      const sshHash =
        this.platform === 'win32'
          ? TESTED_SSH_SHA256
          : createHash('sha256')
              .update(await fs.readFile(selection.realSSH))
              .digest('hex');
      const payload = await Promise.all(
        files.map((file) =>
          fs.readFile(path.join(this.options.extensionPath, 'bin', file)),
        ),
      );
      const digest = createHash('sha256');
      for (const bytes of payload) digest.update(bytes);
      if (this.platform === 'darwin')
        digest.update(selection.realSSH).update(sshHash);
      const directory = path.join(
        this.options.storage,
        'bridge-v2',
        this.options.version + '-' + digest.digest('hex').slice(0, 16),
      );
      await fs.mkdir(directory, { recursive: true });
      await this.secure(directory);
      for (let i = 0; i < files.length; i++) {
        const file = path.join(directory, files[i]);
        let existing: Buffer | undefined;
        try {
          existing = await fs.readFile(file);
        } catch {}
        if (existing && !existing.equals(payload[i]))
          throw new SetupError('invalid-deployment');
        if (!existing)
          await fs.writeFile(file, payload[i], { flag: 'wx', mode: 0o700 });
      }
      if (!equal(adapter.read(), current)) {
        adapter.stop();
        throw new SetupError('settings-changed');
      }
      const managedPath = path.join(directory, this.file('ssh'));
      if (
        state?.enabled &&
        state.status === 'ready' &&
        same(state.managedPath, managedPath) &&
        same(current.path, managedPath) &&
        current.useLocalServer === true
      ) {
        await adapter.start(directory);
        return 'ready';
      }
      const pending: Control = {
        version: this.options.version,
        enabled: true,
        status: 'pending',
        revision: randomUUID(),
        managedPath,
        original: selection.original,
        before: current,
      };
      const config = {
        realSSH: selection.realSSH,
        realSCP: path.join(path.dirname(selection.realSSH), this.file('scp')),
        realSSHHash: sshHash,
        enabled: true,
      };
      await this.write(path.join(directory, 'bridge.json'), config);
      await this.write(path.join(directory, 'recovery.json'), {
        bridgePath: managedPath,
        original: selection.original,
      });
      await this.write(this.controlPath, pending);
      const attempted = new Set<string>();
      try {
        await adapter.start(directory);
        if (!equal(adapter.read(), current))
          throw new SetupError('settings-changed');
        attempted.add('path');
        await adapter.write('path', managedPath);
        const now = adapter.read();
        if (
          !same(now.path, managedPath) ||
          (now.useLocalServer !== current.useLocalServer &&
            now.useLocalServer !== true)
        )
          throw new SetupError('settings-changed');
        attempted.add('useLocalServer');
        await adapter.write('useLocalServer', true);
        await this.write(this.controlPath, { ...pending, status: 'ready' });
        return 'ready';
      } catch (error) {
        adapter.stop();
        const now = adapter.read();
        const changes = restoration(
          {
            ...now,
            path: same(now.path, managedPath) ? managedPath : now.path,
          },
          { bridgePath: managedPath, original: selection.original },
        );
        for (const [key, change] of Object.entries(changes))
          if (attempted.has(key))
            await adapter.write(key as 'path' | 'useLocalServer', change.value);
        await this.write(this.controlPath, {
          ...pending,
          status:
            (error as SetupError).code === 'settings-changed'
              ? 'suspended'
              : 'pending',
        });
        throw error;
      }
    });
  }
  async disable(): Promise<void> {
    await this.locked(async () => {
      const old = await this.control(),
        adapter = this.options.adapter;
      await this.write(this.controlPath, {
        ...old,
        version: old?.version || this.options.version,
        enabled: false,
        status: 'ready',
        revision: randomUUID(),
      });
      adapter.stop();
      const owned =
        old?.managedPath && old.original
          ? { bridgePath: old.managedPath, original: old.original }
          : this.options.legacyOwned;
      if (owned) {
        const current = adapter.read();
        const changes = restoration(
          {
            ...current,
            path: same(current.path, owned.bridgePath)
              ? owned.bridgePath
              : current.path,
          },
          owned,
        );
        for (const [key, change] of Object.entries(changes))
          await adapter.write(key as 'path' | 'useLocalServer', change.value);
        const file = path.join(path.dirname(owned.bridgePath), 'bridge.json');
        const config = await this.read(file);
        if (config) await this.write(file, { ...config, enabled: false });
      }
    });
  }
}
