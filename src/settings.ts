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
