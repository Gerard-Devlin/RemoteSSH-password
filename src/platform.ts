import * as path from 'node:path';
export function supportedPlatform(
  platform = process.platform,
  arch = process.arch,
): boolean {
  return (
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'darwin' && (arch === 'x64' || arch === 'arm64'))
  );
}
export function executableName(name: string, platform = process.platform) {
  return platform === 'win32' ? name + '.exe' : name;
}
export function defaultSSH(platform = process.platform) {
  if (process.env.SSHPM_REAL_SSH) return process.env.SSHPM_REAL_SSH;
  return platform === 'win32'
    ? path.join(
        process.env.WINDIR || 'C:\\Windows',
        'System32',
        'OpenSSH',
        'ssh.exe',
      )
    : '/usr/bin/ssh';
}
