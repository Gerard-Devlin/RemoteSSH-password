import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TESTED_SSH_SHA256 } = require('../dist/compatibility.js');
let actual = 'unavailable';
if (process.platform === 'win32' && process.env.WINDIR) {
  try {
    actual = createHash('sha256')
      .update(
        await fs.readFile(
          path.join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe'),
        ),
      )
      .digest('hex');
  } catch (error) {
    if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
  }
}
let supported = actual === TESTED_SSH_SHA256;
if (process.platform === 'darwin') {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('/usr/bin/ssh', ['-V'], { encoding: 'utf8' });
  actual = (result.stdout + result.stderr).trim();
  const match = /^OpenSSH_(\d+)\./.exec(actual);
  supported = result.status === 0 && !!match && Number(match[1]) >= 9;
}
const summary = [
  '### OpenSSH integration coverage',
  '',
  'System OpenSSH: `' + actual + '`.',
  '',
  supported
    ? 'The supported build is present. Loopback and bilingual mocked-API integration steps will run; see their step results.'
    : '**NOT RUN:** loopback and bilingual mocked-API integration require a supported OpenSSH build. Unit tests and packaging do not replace this coverage.',
  '',
  'Real VS Code host/UI and manual Remote-SSH acceptance are not run by this workflow.',
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_OUTPUT)
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    'supported=' + supported + '\n',
  );
if (process.env.GITHUB_STEP_SUMMARY)
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
