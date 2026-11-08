import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
} from 'jsonc-parser/lib/esm/main.js';
import { SettingSnapshot } from './settings';

export interface UninstallState {
  version: 1;
  storage: string;
  settingsPath: string;
  bridgePath: string;
  original: SettingSnapshot;
}

const validPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length < 32768 &&
  path.isAbsolute(value) &&
  !/[\r\n\x00]/.test(value);

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

export function settingsPathForStorage(storage: string): string | undefined {
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  const marker = paths.sep + 'globalStorage' + paths.sep;
  const index = storage.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (index < 1) return undefined;
  return paths.join(storage.slice(0, index), 'settings.json');
}

function validSnapshot(value: unknown): value is SettingSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    (snapshot.path === undefined || validPath(snapshot.path)) &&
    (snapshot.useLocalServer === undefined ||
      typeof snapshot.useLocalServer === 'boolean')
  );
}

function validState(value: unknown): value is UninstallState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    validPath(state.storage) &&
    validPath(state.settingsPath) &&
    validPath(state.bridgePath) &&
    validSnapshot(state.original)
  );
}

async function writeAtomic(file: string, content: string) {
  const temporary =
    file +
    '.' +
    process.pid +
    '.' +
    Math.random().toString(16).slice(2) +
    '.tmp';
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function writeUninstallState(options: {
  storage: string;
  extensionPath: string;
  bridgePath: string;
  original: SettingSnapshot;
}): Promise<void> {
  const settingsPath = settingsPathForStorage(options.storage);
  if (!settingsPath) return;
  const state: UninstallState = {
    version: 1,
    storage: options.storage,
    settingsPath,
    bridgePath: options.bridgePath,
    original: { ...options.original },
  };
  const content = JSON.stringify(state, null, 2) + '\n';
  await Promise.all([
    writeAtomic(path.join(options.storage, 'uninstall-v1.json'), content),
    writeAtomic(path.join(options.extensionPath, 'uninstall-v1.json'), content),
  ]);
}

export async function removeUninstallState(options: {
  storage: string;
  extensionPath: string;
}): Promise<void> {
  await Promise.all([
    fs.unlink(path.join(options.storage, 'uninstall-v1.json')).catch(() => {}),
    fs
      .unlink(path.join(options.extensionPath, 'uninstall-v1.json'))
      .catch(() => {}),
  ]);
}

function stateFromEnvironment(): string {
  const override = process.env.SSHPM_UNINSTALL_STATE;
  if (override) return path.resolve(override);
  return path.resolve(__dirname, '..', 'uninstall-v1.json');
}

function updateSetting(
  source: string,
  key: 'path' | 'useLocalServer',
  value: string | boolean | undefined,
): string {
  return undefined === value
    ? applyModification(source, key, undefined)
    : applyModification(source, key, value);
}

function applyModification(
  source: string,
  key: 'path' | 'useLocalServer',
  value: string | boolean | undefined,
): string {
  const edits = modify(source, ['remote.SSH', key], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: source.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  return applyEdits(source, edits);
}

export async function restoreSettings(state: UninstallState): Promise<boolean> {
  let source: string;
  try {
    source = await fs.readFile(state.settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const errors: ParseError[] = [];
  const settings = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !settings || typeof settings !== 'object') return false;
  const remote = (settings as Record<string, unknown>)['remote.SSH'];
  if (!remote || typeof remote !== 'object' || Array.isArray(remote))
    return false;
  const current = remote as Record<string, unknown>;
  let updated = source;
  if (
    typeof current.path === 'string' &&
    samePath(current.path, state.bridgePath)
  )
    updated = updateSetting(updated, 'path', state.original.path);
  if (current.useLocalServer === true)
    updated = updateSetting(
      updated,
      'useLocalServer',
      state.original.useLocalServer,
    );
  if (updated !== source) await writeAtomic(state.settingsPath, updated);
  return updated !== source;
}

async function disableBridge(bridgePath: string): Promise<void> {
  const file = path.join(path.dirname(bridgePath), 'bridge.json');
  try {
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    if (config && typeof config === 'object' && !Array.isArray(config))
      await writeAtomic(file, JSON.stringify({ ...config, enabled: false }));
  } catch {}
}

export async function runUninstall(): Promise<void> {
  const statePath = stateFromEnvironment();
  let state: unknown;
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return;
  }
  if (!validState(state)) return;
  await restoreSettings(state);
  await disableBridge(state.bridgePath);
}

if (require.main === module)
  void runUninstall().catch(() => {
    // Uninstall must not be blocked by best-effort settings recovery.
    process.exitCode = 0;
  });
