import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFile(path.join(root, name), 'utf8');
const manifest = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
const markdown = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'TEST-RESULTS.md',
];
async function collect(dir) {
  for (const entry of await fs.readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.name.endsWith('.md')) markdown.push(file);
  }
}
await collect('docs');

async function exactFile(relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    assert.ok(
      (await fs.readdir(current)).includes(segment),
      'Missing or case-mismatched local link: ' + relative,
    );
    current = path.join(current, segment);
  }
  assert.ok((await fs.stat(current)).isFile(), relative);
}

test('documentation links and image references resolve with repository-exact casing', async () => {
  let checked = 0;
  for (const file of markdown) {
    const content = (await read(file)).replace(
      /\x60\x60\x60[^]*?\x60\x60\x60/g,
      '',
    );
    const links = [
      ...[...content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(
        (m) => m[1],
      ),
      ...[...content.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(
        (m) => m[1],
      ),
    ];
    for (const link of links) {
      if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('#')) continue;
      assert.ok(
        !link.startsWith('/'),
        'Use repository-relative links: ' + link,
      );
      const destination = decodeURIComponent(link.split(/[?#]/)[0]);
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), destination),
      );
      assert.ok(
        relative !== '..' && !relative.startsWith('../'),
        'Link escapes repository: ' + link,
      );
      await exactFile(relative);
      checked++;
    }
  }
  assert.ok(checked > 30, 'Documentation should cross-link its local guides');
});

test('main README is English and includes installation, compatibility, security, and contribution paths', async () => {
  const readme = await read('README.md');
  assert.ok(!/[\u3400-\u9fff]/u.test(readme));
  for (const section of [
    '## Quick start',
    '## Commands',
    '## Language',
    '## Security and scope',
    '## Development',
    '## License',
  ])
    assert.ok(readme.includes(section), section);
  for (const file of [
    'docs/compatibility.md',
    'docs/troubleshooting.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ])
    assert.ok(readme.includes(file));
  assert.ok(
    !readme.includes('D:\\PycharmProjects'),
    'Do not publish a local workstation path',
  );
});

test('release versions and README installation example agree', async () => {
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.ok((await read('CHANGELOG.md')).includes('## ' + manifest.version));
  assert.ok(
    (await read('README.md')).includes(
      manifest.name + '-' + manifest.version + '-win32-x64.vsix',
    ),
  );
});

test('supplied square PNG is the extension and README icon', async () => {
  assert.equal(manifest.icon, 'media/icon.png');
  const icon = await fs.readFile(path.join(root, manifest.icon));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20));
  assert.ok(icon.readUInt32BE(16) >= 128);
  assert.ok((await read('README.md')).includes('src="' + manifest.icon + '"'));
});

test('repository contribution and issue entry points exist', async () => {
  for (const file of [
    'LICENSE',
    '.editorconfig',
    '.gitattributes',
    '.github/workflows/ci.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ])
    await exactFile(file);
});
