import * as path from 'node:path';
import { executableName } from './platform';
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
  platform: NodeJS.Platform = 'win32',
): string | undefined {
  if (!validPath(executable)) return;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const sameWindowsPath = (a: string, b: string) =>
    platform === 'win32'
      ? paths.resolve(a).toLowerCase() === paths.resolve(b).toLowerCase()
      : paths.resolve(a) === paths.resolve(b);
  return directories.find((dir) =>
    sameWindowsPath(
      executable,
      paths.join(dir, executableName('ssh', platform)),
    ),
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
  platform: NodeJS.Platform = 'win32',
): SSHSelection {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const sameWindowsPath = (a: string, b: string) =>
    platform === 'win32'
      ? paths.resolve(a).toLowerCase() === paths.resolve(b).toLowerCase()
      : paths.resolve(a) === paths.resolve(b);
  const directory = managedBridgeDirectory(current.path, directories, platform);
  if (!directory)
    return {
      original: { ...current },
      realSSH: current.path || defaultSSH,
      migration: 'none',
    };
  const usable = (value: unknown): value is string =>
    validPath(value) &&
    paths.isAbsolute(value) &&
    !directories.some((dir) => sameWindowsPath(paths.dirname(value), dir));
  if (
    objectValue(recovery) &&
    validPath(recovery.bridgePath) &&
    sameWindowsPath(
      recovery.bridgePath,
      paths.join(directory, executableName('ssh', platform)),
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
