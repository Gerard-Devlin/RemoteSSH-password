import fs from 'node:fs/promises';
import path from 'node:path';

const kind =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'patch';
const dryRun = process.argv.includes('--dry-run');
if (!['patch', 'minor', 'major'].includes(kind))
  throw new Error('Use patch, minor, or major.');
const root = process.cwd();
const read = (file) => fs.readFile(path.join(root, file), 'utf8');
const manifest = JSON.parse(await read('package.json'));
if (manifest.name !== 'remote-ssh-password-memory')
  throw new Error('Run this command in the RemoteSSH-password project.');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error('The current version must be numeric major.minor.patch.');
const parts = manifest.version.split('.').map(Number);
const index = { major: 0, minor: 1, patch: 2 }[kind];
parts[index]++;
for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
const previous = manifest.version;
const next = parts.join('.');
const changes = new Map();
manifest.version = next;
changes.set('package.json', JSON.stringify(manifest, null, 2) + '\n');
const lock = JSON.parse(await read('package-lock.json'));
lock.version = next;
lock.packages[''].version = next;
changes.set('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
for (const file of ['README.md', 'docs/README.zh-CN.md']) {
  changes.set(file, (await read(file)).replaceAll(previous, next));
}
let changelog = await read('CHANGELOG.md');
const unreleased = /^## Unreleased\s*\n([^]*?)(?=^## |$(?![^]))/m.exec(
  changelog,
);
const notes = unreleased?.[1].trim() || '- Maintenance update.';
if (unreleased) changelog = changelog.replace(unreleased[0], '');
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
changelog = changelog.replace(
  /^# Changelog\s*/,
  () =>
    '# Changelog\n\n## Unreleased\n\n## ' +
    next +
    ' — ' +
    date +
    '\n\n' +
    notes +
    '\n\n',
);
changes.set('CHANGELOG.md', changelog);
console.log((dryRun ? 'Dry run: ' : '') + previous + ' → ' + next);
for (const [file, content] of changes) {
  console.log(file);
  if (!dryRun) await fs.writeFile(path.join(root, file), content, 'utf8');
}
