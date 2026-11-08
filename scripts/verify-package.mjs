import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { targetOptions } from './platform.mjs';
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const { target, suffix, goarch } = targetOptions();
const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
const filename =
  metadata.name + '-' + metadata.version + '-' + target + '.vsix';
const packageIndex = process.argv.indexOf('--package');
const packagePath =
  packageIndex < 0
    ? path.resolve('artifacts', filename)
    : path.resolve(process.argv[packageIndex + 1]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const entries = await new Promise((resolve, reject) => {
  yauzl.open(packagePath, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const files = new Map();
    zip.on('error', reject);
    zip.on('entry', (entry) => {
      if (entry.fileName.endsWith('/')) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          files.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.on('end', () => resolve(files));
    zip.readEntry();
  });
});
const manifest = entries.get('extension.vsixmanifest')?.toString();
assert.ok(
  manifest?.includes('TargetPlatform="' + target + '"'),
  'Wrong VSIX target',
);
const packaged = JSON.parse(entries.get('extension/package.json'));
for (const key of ['name', 'publisher', 'version'])
  assert.equal(packaged[key], metadata[key]);
assert.equal(packaged.engines.vscode, metadata.engines.vscode);
assert.equal(packaged.scripts['vscode:uninstall'], 'node ./dist/uninstall.js');
assert.ok(manifest.includes('Version="' + metadata.version + '"'));
const expectedHelpers = ['ssh', 'scp', 'askpass', 'broker']
  .map((name) => 'extension/bin/' + name + suffix)
  .sort();
const expectedEntries = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/CONTRIBUTING.md',
  'extension/LICENSE.txt',
  'extension/SECURITY.md',
  'extension/TEST-RESULTS.md',
  'extension/THIRD-PARTY-NOTICES.txt',
  ...expectedHelpers,
  'extension/changelog.md',
  'extension/dist/compatibility.generated.js',
  'extension/dist/compatibility.js',
  'extension/dist/core.js',
  'extension/dist/extension.js',
  'extension/dist/hostIdentity.js',
  'extension/dist/platform.js',
  'extension/dist/settings.js',
  'extension/dist/setup.js',
  'extension/dist/uninstall.js',
  'extension/docs/README.zh-CN.md',
  'extension/docs/architecture.md',
  'extension/docs/compatibility.md',
  'extension/docs/marketplace.md',
  'extension/docs/testing.md',
  'extension/docs/testing/2026-11-05.md',
  'extension/docs/testing/2026-11-06.md',
  'extension/docs/testing/2026-11-07.md',
  'extension/docs/testing/2026-11-09.md',
  'extension/docs/troubleshooting.md',
  'extension/docs/ui-text.md',
  'extension/l10n/bundle.l10n.zh-cn.json',
  'extension/media/icon.png',
  'extension/media/readme-logo.png',
  'extension/package.json',
  'extension/package.nls.json',
  'extension/package.nls.zh-cn.json',
  'extension/readme.md',
].sort();
assert.deepEqual(
  [...entries.keys()].sort(),
  expectedEntries,
  'Unexpected or missing VSIX inventory',
);
assert.deepEqual(
  [...entries.keys()]
    .filter((name) => name.startsWith('extension/bin/'))
    .sort(),
  expectedHelpers,
);
const nativeHashes = {},
  fileHashes = {};
for (const [name, bytes] of entries) {
  assert.ok(
    !/^(extension\/(src|native|scripts|node_modules|artifacts|\.test-runtime)\/)/.test(
      name,
    ),
    'Development files in VSIX',
  );
  fileHashes[name] = hash(bytes);
  if (!name.startsWith('extension/')) continue;
  let relative = name.slice('extension/'.length);
  if (relative === 'LICENSE.txt') relative = 'LICENSE';
  if (relative === 'readme.md') relative = 'README.md';
  if (relative === 'changelog.md') relative = 'CHANGELOG.md';
  assert.equal(
    hash(await fs.readFile(relative)),
    hash(bytes),
    'Packaged file differs from source: ' + relative,
  );
  if (!expectedHelpers.includes(name)) continue;
  nativeHashes[relative] = hash(bytes);
  if (target === 'win32-x64') {
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4), 0x8664);
  } else {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Not a Mach-O binary');
    assert.equal(
      bytes.readUInt32LE(4),
      goarch === 'arm64' ? 0x100000c : 0x1000007,
      'Wrong Mac architecture',
    );
  }
}
for (const name of [
  'dist/extension.js',
  'dist/platform.js',
  'dist/core.js',
  'dist/setup.js',
  'l10n/bundle.l10n.zh-cn.json',
  'media/icon.png',
  'readme.md',
])
  assert.ok(
    entries.has('extension/' + name),
    'Missing packaged runtime file: ' + name,
  );
const bytes = await fs.readFile(packagePath);
const record = {
  package: packagePath,
  bytes: bytes.length,
  sha256: hash(bytes),
  publisher: metadata.publisher,
  extensionId: metadata.publisher + '.' + metadata.name,
  version: metadata.version,
  target,
  files: [...entries.keys()],
  fileHashes,
  nativeHashes,
  verified: true,
};
const commitIndex = process.argv.indexOf('--commit');
if (commitIndex >= 0) {
  record.sourceCommit = process.argv[commitIndex + 1];
  assert.match(record.sourceCommit, /^[a-f0-9]{40}$/);
}
await fs.writeFile(
  'artifacts/package-verification-' + target + '.json',
  JSON.stringify(record, null, 2) + '\n',
);
await fs.writeFile(
  'artifacts/SHA256SUMS-' + target + '.txt',
  record.sha256 + '  ' + filename + '\n',
);
console.log(
  'Verified ' +
    filename +
    ' (' +
    bytes.length +
    ' bytes) SHA256 ' +
    record.sha256,
);
