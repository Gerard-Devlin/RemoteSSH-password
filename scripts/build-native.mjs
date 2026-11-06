import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { targetOptions } from './platform.mjs';
const { target, goos, goarch, suffix } = targetOptions();
mkdirSync('bin', { recursive: true });
mkdirSync('artifacts', { recursive: true });
for (const name of ['ssh', 'scp', 'askpass', 'broker'])
  for (const extension of ['', '.exe'])
    rmSync('bin/' + name + extension, { force: true });
const r = spawnSync(
  'go',
  ['build', '-trimpath', '-ldflags=-s -w', '-o', '../bin/ssh' + suffix, '.'],
  {
    cwd: 'native',
    stdio: 'inherit',
    env: {
      ...process.env,
      GOOS: goos,
      GOARCH: goarch,
      CGO_ENABLED: goos === 'darwin' ? '1' : '0',
    },
  },
);
if (r.error) throw r.error;
if (r.status !== 0) process.exit(r.status ?? 1);
for (const name of ['scp', 'askpass', 'broker'])
  copyFileSync('bin/ssh' + suffix, 'bin/' + name + suffix);
writeFileSync('bin/build-target.json', JSON.stringify({ target }));
