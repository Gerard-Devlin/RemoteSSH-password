import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'sshpm-vscode-1-73-'),
);
const development = path.join(temporary, 'extension');
const userData = path.join(temporary, 'user-data');
const extensions = path.join(temporary, 'extensions');

try {
  await fs.mkdir(development, { recursive: true });
  for (const entry of [
    'dist',
    'bin',
    'l10n',
    'media',
    'package.nls.json',
    'package.nls.zh-cn.json',
  ])
    await fs.cp(path.join(root, entry), path.join(development, entry), {
      recursive: true,
    });

  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  );
  delete manifest.extensionDependencies;
  manifest.version = manifest.version + '-vscode-1-73-compat';
  await fs.writeFile(
    path.join(development, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  await runTests({
    version: '1.73.0',
    extensionDevelopmentPath: development,
    extensionTestsPath: path.join(root, 'scripts/vscode-compat-runner.cjs'),
    launchArgs: [
      '--user-data-dir=' + userData,
      '--extensions-dir=' + extensions,
      '--disable-updates',
      '--disable-telemetry',
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
    ],
  });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
