import fs from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'native', 'windows-openssh.json');
const outputPath = path.join(root, 'src', 'compatibility.generated.ts');
const check = process.argv.includes('--check');
const data = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const profiles = data?.profiles;
const fail = (message) => {
  throw new Error('Invalid Windows OpenSSH profile: ' + message);
};
if (!Array.isArray(profiles) || !profiles.length) fail('profiles is empty');
const ids = new Set();
const hashes = new Set();
for (const profile of profiles) {
  for (const key of [
    'id',
    'displayVersion',
    'versionMarker',
    'sha256',
    'logVerbose',
  ])
    if (typeof profile[key] !== 'string' || !profile[key])
      fail(profile.id + ' missing ' + key);
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(profile.id))
    fail('invalid id ' + profile.id);
  if (!/^[a-f0-9]{64}$/.test(profile.sha256))
    fail(profile.id + ' has an invalid SHA256');
  if (ids.has(profile.id)) fail('duplicate id ' + profile.id);
  if (hashes.has(profile.sha256)) fail('duplicate hash ' + profile.sha256);
  ids.add(profile.id);
  hashes.add(profile.sha256);
  if (profile.archive) {
    if (
      !/^https:\/\/github\.com\/PowerShell\/Win32-OpenSSH\/releases\/download\//.test(
        profile.archive.url,
      ) ||
      !/^[a-f0-9]{64}$/.test(profile.archive.sha256)
    )
      fail(profile.id + ' has invalid archive metadata');
  }
}

const raw = `// Generated from native/windows-openssh.json. Do not edit directly.
export const WINDOWS_OPENSSH_PROFILES = ${JSON.stringify(profiles, null, 2)} as const;
`;
const output = await prettier.format(raw, {
  ...(await prettier.resolveConfig(outputPath)),
  parser: 'typescript',
});
if (check) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '');
  if (current !== output)
    throw new Error(
      'compatibility.generated.ts is stale; run npm run generate:compatibility',
    );
} else {
  await fs.writeFile(outputPath, output);
}
