import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { suffix } from './platform.mjs';
mkdirSync('bin', { recursive: true });
const result = spawnSync(
  'go',
  ['build', '-o', '../../bin/testserver' + suffix, '.'],
  { cwd: 'native/testserver', stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
