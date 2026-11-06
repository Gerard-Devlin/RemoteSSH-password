import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { targetOptions } from './platform.mjs';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const { target } = targetOptions();
const build = spawnSync(
  process.execPath,
  ['scripts/build-native.mjs', '--target', target],
  { stdio: 'inherit' },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
await mkdir('artifacts', { recursive: true });
const output = path.join(
  'artifacts',
  manifest.name + '-' + manifest.version + '-' + target + '.vsix',
);
const args = [
  require.resolve('@vscode/vsce/vsce'),
  'package',
  '--target',
  target,
  '--no-dependencies',
  '--out',
  output,
];
// Keep normal vsce link processing enabled for Marketplace packages.
if (!manifest.repository)
  throw new Error('A repository URL is required for the upload package.');
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
