export const targets = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
export function targetOptions(target) {
  if (target === undefined) {
    const index = process.argv.indexOf('--target');
    target =
      index < 0
        ? process.platform + '-' + process.arch
        : process.argv[index + 1];
  }
  if (!targets.includes(target))
    throw new Error('Unsupported target: ' + target);
  const [platform, arch] = target.split('-');
  return {
    target,
    platform,
    suffix: platform === 'win32' ? '.exe' : '',
    goos: platform === 'win32' ? 'windows' : 'darwin',
    goarch: arch === 'x64' ? 'amd64' : 'arm64',
  };
}
export const suffix = process.platform === 'win32' ? '.exe' : '';
export const realSSH =
  process.platform === 'win32'
    ? process.env.WINDIR + '/System32/OpenSSH/ssh.exe'
    : '/usr/bin/ssh';
export const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
