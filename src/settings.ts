import * as path from 'node:path';
export interface SettingSnapshot {
  path?: string;
  useLocalServer?: boolean;
}
export interface OwnedSettings {
  original: SettingSnapshot;
  bridgePath: string;
}
// Restore only the exact value that this extension last installed.
export function restoration(
  current: SettingSnapshot,
  state: OwnedSettings,
): Partial<
  Record<keyof SettingSnapshot, { value: string | boolean | undefined }>
> {
  const result: Partial<
    Record<keyof SettingSnapshot, { value: string | boolean | undefined }>
  > = {};
  if (current.path === state.bridgePath)
    result.path = { value: state.original.path };
  if (current.useLocalServer === true)
    result.useLocalServer = { value: state.original.useLocalServer };
  return result;
}

const sameWindowsPath = (a: string, b: string) =>
  path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
const validPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length < 32768 &&
  !/[\r\n\x00]/.test(value);
const objectValue = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function managedBridgeDirectory(
  executable: string | undefined,
  directories: readonly string[],
): string | undefined {
  if (!validPath(executable)) return;
  return directories.find((dir) =>
    sameWindowsPath(executable, path.win32.join(dir, 'ssh.exe')),
  );
}
export interface SSHSelection {
  original: SettingSnapshot;
  realSSH: string;
  migration: 'none' | 'recovered' | 'fallback';
}
// Only exact, known helper locations are eligible. Unrelated wrappers remain user settings.
// Candidates still pass the executable/version/hash checks before any setting is changed.
export function selectSSHSettings(
  current: SettingSnapshot,
  defaultSSH: string,
  directories: readonly string[],
  recovery?: unknown,
  configuration?: unknown,
): SSHSelection {
  const directory = managedBridgeDirectory(current.path, directories);
  if (!directory)
    return {
      original: { ...current },
      realSSH: current.path || defaultSSH,
      migration: 'none',
    };
  const usable = (value: unknown): value is string =>
    validPath(value) &&
    path.win32.isAbsolute(value) &&
    !directories.some((dir) => sameWindowsPath(path.win32.dirname(value), dir));
  if (
    objectValue(recovery) &&
    validPath(recovery.bridgePath) &&
    sameWindowsPath(
      recovery.bridgePath,
      path.win32.join(directory, 'ssh.exe'),
    ) &&
    objectValue(recovery.original)
  ) {
    const snapshot = recovery.original;
    if (
      (snapshot.path === undefined || usable(snapshot.path)) &&
      (snapshot.useLocalServer === undefined ||
        typeof snapshot.useLocalServer === 'boolean')
    ) {
      return {
        original: {
          path: snapshot.path as string | undefined,
          useLocalServer:
            current.useLocalServer === true
              ? (snapshot.useLocalServer as boolean | undefined)
              : current.useLocalServer,
        },
        realSSH: (snapshot.path as string) || defaultSSH,
        migration: 'recovered',
      };
    }
  }
  // A removed preview may leave only remote.SSH.path behind. Never journal that dead path.
  const realSSH =
    objectValue(configuration) && usable(configuration.realSSH)
      ? configuration.realSSH
      : defaultSSH;
  return {
    original: { ...current, path: realSSH },
    realSSH,
    migration: 'fallback',
  };
}
