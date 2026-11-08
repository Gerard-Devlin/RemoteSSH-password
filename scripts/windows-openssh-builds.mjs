import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const root = process.cwd();
const profiles = JSON.parse(
  await fs.readFile(path.join(root, 'native', 'windows-openssh.json'), 'utf8'),
).profiles.filter((profile) => profile.archive);
const verifyArchives = process.argv.includes('--verify-archives');

if (process.platform !== 'win32' && !verifyArchives) {
  console.log('SKIP Windows OpenSSH build matrix on non-Windows host');
  process.exit(0);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function download(url, expected) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok)
        throw new Error('HTTP ' + response.status + ' for ' + url);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== expected)
        throw new Error(
          'Archive SHA256 mismatch: expected ' +
            expected +
            ', received ' +
            actual,
        );
      return bytes;
    } catch (error) {
      last = error;
      if (attempt < 3) await sleep(500 * 2 ** attempt);
    }
  }
  throw last;
}

function extractZip(bytes, destination) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        const target = path.resolve(destination, entry.fileName);
        const relative = path.relative(destination, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          return reject(new Error('Unsafe archive path: ' + entry.fileName));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', async () => {
            try {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, Buffer.concat(chunks), {
                mode: entry.externalFileAttributes >>> 16 || 0o600,
              });
              zip.readEntry();
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

const run = (args, environment, label) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(label + ' failed');
};

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'sshpm-windows-builds-'),
);
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
const failures = [];
try {
  for (const profile of profiles) {
    try {
      console.log('\n=== ' + profile.displayVersion + ' ===');
      const archive = await download(
        profile.archive.url,
        profile.archive.sha256,
      );
      const directory = path.join(temporary, profile.id);
      await extractZip(archive, directory);
      const ssh = path.join(directory, 'OpenSSH-Win64', 'ssh.exe');
      const bytes = await fs.readFile(ssh);
      const actual = sha256(bytes);
      if (actual !== profile.sha256)
        throw new Error(
          profile.id + ' ssh.exe SHA256 mismatch: received ' + actual,
        );
      await fs.access(path.join(directory, 'OpenSSH-Win64', 'scp.exe'));
      if (verifyArchives && process.platform !== 'win32') {
        console.log('Verified archive and ssh.exe hashes for ' + profile.id);
        continue;
      }
      const version = spawnSync(ssh, ['-V'], { encoding: 'utf8' });
      const label = (version.stdout || '') + (version.stderr || '');
      if (version.status !== 0 || !label.includes(profile.versionMarker))
        throw new Error(
          profile.id + ' version mismatch: ' + JSON.stringify(label),
        );
      run(
        ['scripts/integration.mjs'],
        {
          SSHPM_REAL_SSH: ssh,
          SSHPM_INTEGRATION_RESULT: path.join(
            root,
            'artifacts',
            'integration-results-' + profile.id + '.json',
          ),
        },
        profile.id + ' integration',
      );
      run(
        ['scripts/extension-tests.mjs', 'en'],
        {
          SSHPM_REAL_SSH: ssh,
          SSHPM_EXTENSION_RESULT: path.join(
            root,
            'artifacts',
            'extension-results-' + profile.id + '.json',
          ),
        },
        profile.id + ' extension-entry',
      );
    } catch (error) {
      console.error(String(error?.stack || error));
      failures.push(profile.id);
    }
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
if (failures.length)
  throw new Error('Windows OpenSSH profile failures: ' + failures.join(', '));
