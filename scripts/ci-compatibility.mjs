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
const supported = actual === TESTED_SSH_SHA256;
const summary = [
  '### OpenSSH integration coverage',
  '',
  'System ssh.exe SHA256: `' + actual + '`.',
  '',
  supported
    ? 'The supported build is present. Loopback and bilingual mocked-API integration steps will run; see their step results.'
    : '**NOT RUN:** loopback and bilingual mocked-API integration require the pinned OpenSSH build. Unit tests and packaging do not replace this coverage.',
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
