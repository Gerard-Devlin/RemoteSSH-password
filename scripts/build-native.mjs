import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('bin', { recursive: true });
mkdirSync('artifacts', { recursive: true });
const r = spawnSync(
  'go',
  ['build', '-trimpath', '-ldflags=-s -w', '-o', '../bin/ssh.exe', '.'],
  {
    cwd: 'native',
    stdio: 'inherit',
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  },
);
if (r.status !== 0) process.exit(r.status ?? 1);
for (const name of ['scp.exe', 'askpass.exe', 'broker.exe'])
  copyFileSync('bin/ssh.exe', 'bin/' + name);
