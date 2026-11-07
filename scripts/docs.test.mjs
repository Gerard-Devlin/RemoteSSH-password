import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
      if (link.startsWith('#')) continue;
      const repositoryRoots = [
        'https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/',
        'https://raw.githubusercontent.com/Gerard-Devlin/RemoteSSH-password/main/',
      ];
      const repositoryRoot = repositoryRoots.find((prefix) =>
        link.startsWith(prefix),
      );
      if (repositoryRoot) {
        await exactFile(
          decodeURIComponent(
            link.slice(repositoryRoot.length).split(/[?#]/)[0],
          ),
        );
        checked++;
        continue;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
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

test('Marketplace icon and original README artwork use independent assets', async () => {
  assert.equal(manifest.icon, 'media/icon.png');
  const icon = await fs.readFile(path.join(root, manifest.icon));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20));
  assert.ok(icon.readUInt32BE(16) >= 128);
  assert.ok(
    icon.readUInt32BE(16) <= 1024,
    'Marketplace icons must not exceed 1024 pixels',
  );
  const artwork = await fs.readFile(path.join(root, 'media/readme-logo.png'));
  assert.equal(
    createHash('sha256').update(artwork).digest('hex'),
    'dc1827c8d37ccaf2e49234698731df54c360f31f4e3e6fd1a675f98b1653a072',
  );
  assert.ok(
    (await read('README.md')).includes(
      'src="https://raw.githubusercontent.com/Gerard-Devlin/RemoteSSH-password/main/media/readme-logo.png"',
    ),
  );
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

test('Marketplace README links and images use HTTPS or local section anchors', async () => {
  const content = await read('README.md');
  const links = [...content.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  links.push(
    ...[...content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)].map((m) => m[1]),
  );
  assert.ok(links.length > 10);
  for (const link of links)
    assert.ok(link.startsWith('https://') || link.startsWith('#'), link);
});

test('stable distribution is explicit and automatic distribution stays preview-only', async () => {
  const workflow = await read('.github/workflows/publish.yml');
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.ok(workflow.includes('options: [stable, preview]'));
  assert.ok(workflow.includes('source_run_id'));
  assert.ok(workflow.includes("inputs.release_channel || 'preview'"));
  assert.ok(workflow.includes('-Channel $env:RELEASE_CHANNEL'));
  const release = await read('scripts/release-from-ci.ps1');
  assert.ok(
    release.includes(
      "[ValidateSet('preview','stable')][string]$Channel='preview'",
    ),
  );
  assert.ok(
    release.includes(
      "$env:GITHUB_EVENT_NAME -notin @('workflow_run','workflow_dispatch')",
    ),
  );
  assert.ok(release.includes("if($prerelease){$releaseArgs+='--prerelease'}"));
  assert.ok(!/gh\s+release\s+create[^]*--prerelease/.test(release));
});

test('release metadata and package hygiene do not advertise a preview', async () => {
  const english = JSON.parse(await read('package.nls.json'));
  const chinese = JSON.parse(await read('package.nls.zh-cn.json'));
  assert.ok(!/preview/i.test(english['extension.description']));
  assert.ok(!chinese['extension.description'].includes('预览'));
  assert.ok(!/^> \*\*Preview/m.test(await read('README.md')));
  const ignore = await read('.vscodeignore');
  for (const pattern of ['.env.*', '*.log', '**/.DS_Store'])
    assert.ok(ignore.includes(pattern), pattern);
});
