import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SetupManager } from '../setup';
import { SettingSnapshot } from '../settings';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sshpm-setup-'));
  const extension = path.join(root, 'extension'),
    storage = path.join(root, 'storage');
  await fs.mkdir(path.join(extension, 'bin'), { recursive: true });
  for (const file of ['ssh.exe', 'scp.exe', 'askpass.exe', 'broker.exe'])
    await fs.writeFile(
      path.join(extension, 'bin', file),
      Buffer.from('fixture-native-' + file),
    );
  let settings: SettingSnapshot = {
    path: path.join(root, 'real', 'ssh.exe'),
    useLocalServer: false,
  };
  const original = { ...settings };
  let fail = false;
  const writes: string[] = [];
  let starts = 0;
  let stops = 0;
  let override: string | undefined;
  const options = {
    storage,
    extensionPath: extension,
    version: '1.0.0',
    validateSSH: async () => {},
    secureDirectory: async () => {},
    adapter: {
      read: () => ({ ...settings }),
      effectivePath: () => override || settings.path,
      write: async (
        key: 'path' | 'useLocalServer',
        value: string | boolean | undefined,
      ) => {
        writes.push(key);
        settings = { ...settings, [key]: value };
      },
      start: async () => {
        starts++;
        if (fail) throw new Error('synthetic start failure');
      },
      stop: () => {
        stops++;
      },
    },
  };
  return {
    root,
    storage,
    extension,
    original,
    options,
    get settings() {
      return settings;
    },
    set settings(v: SettingSnapshot) {
      settings = v;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    writes,
    set fail(v: boolean) {
      fail = v;
    },
    set override(v: string | undefined) {
      override = v;
    },
    manager: () => new SetupManager(options),
  };
}
test('fresh activation automatically deploys adjacent helpers and updates settings once', async () => {
  const h = await fixture(),
    manager = h.manager();
  assert.equal(await manager.ensure(), 'ready');
  assert.equal(h.settings.useLocalServer, true);
  assert.ok(h.settings.path?.includes('bridge-v2'));
  assert.equal(h.writes.length, 2);
  const directory = path.dirname(h.settings.path!);
  for (const file of ['ssh.exe', 'scp.exe', 'askpass.exe', 'broker.exe'])
    assert.deepEqual(
      await fs.readFile(path.join(directory, file)),
      await fs.readFile(path.join(h.extension, 'bin', file)),
    );
  assert.equal(await manager.ensure(), 'ready');
  assert.equal(h.writes.length, 2);
  const recovery = JSON.parse(
    await fs.readFile(path.join(directory, 'recovery.json'), 'utf8'),
  );
  assert.deepEqual(recovery.original, h.original);
});
test('explicit disable survives another activation and explicit enable resumes', async () => {
  const h = await fixture();
  await h.manager().ensure();
  await h.manager().disable();
  assert.deepEqual(h.settings, h.original);
  assert.equal(await h.manager().ensure(), 'disabled');
  assert.deepEqual(h.settings, h.original);
  assert.equal(await h.manager().ensure(true), 'ready');
});
test('later user SSH changes suspend automatic setup without overwriting them', async () => {
  const h = await fixture();
  await h.manager().ensure();
  h.settings = {
    path: path.join(h.root, 'user', 'ssh.exe'),
    useLocalServer: false,
  };
  const edited = { ...h.settings };
  assert.equal(await h.manager().ensure(), 'suspended');
  assert.deepEqual(h.settings, edited);
  assert.equal(await h.manager().ensure(), 'suspended');
});
test('workspace override suspends only that window', async () => {
  const h = await fixture();
  await h.manager().ensure();
  const managed = { ...h.settings };
  h.override = path.join(h.root, 'workspace', 'ssh.exe');
  assert.equal(await h.manager().ensure(), 'suspended');
  assert.deepEqual(h.settings, managed);
  h.override = undefined;
  assert.equal(await h.manager().ensure(), 'ready');
});
test('missing old local-tools helper is recovered automatically', async () => {
  const h = await fixture();
  const old = path.join(
    h.root,
    'local-tools.remote-ssh-password-memory',
    'bridge-v1',
    'ssh.exe',
  );
  h.settings = { path: old, useLocalServer: true };
  assert.equal(await h.manager().ensure(), 'ready');
  const recovery = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(h.settings.path!), 'recovery.json'),
      'utf8',
    ),
  );
  assert.notEqual(recovery.original.path, old);
  await h.manager().disable();
  assert.equal(h.settings.path, recovery.original.path);
});
test('helper upgrades preserve original settings and retain the previous generation', async () => {
  const h = await fixture();
  await h.manager().ensure();
  const first = h.settings.path!;
  const upgraded = new SetupManager({ ...h.options, version: '1.1.0' });
  assert.equal(await upgraded.ensure(), 'ready');
  assert.notEqual(h.settings.path, first);
  await fs.access(first);
  assert.equal(await h.manager().ensure(), 'outdated');
  await upgraded.disable();
  assert.deepEqual(h.settings, h.original);
});
test('failed broker startup leaves settings intact and can retry', async () => {
  const h = await fixture();
  h.fail = true;
  await assert.rejects(h.manager().ensure());
  assert.deepEqual(h.settings, h.original);
  h.fail = false;
  assert.equal(await h.manager().ensure(), 'ready');
  await h.manager().disable();
  assert.deepEqual(h.settings, h.original);
});
test('concurrent setup preserves one original snapshot and later disable wins', async () => {
  const h = await fixture();
  await Promise.all([h.manager().ensure(), h.manager().ensure()]);
  assert.equal(h.writes.length, 2);
  await h.manager().disable();
  assert.deepEqual(h.settings, h.original);
  assert.equal(await h.manager().ensure(), 'disabled');
});
test('an explicit off marker from the previous deployment is respected', async () => {
  const h = await fixture();
  await fs.mkdir(path.join(h.storage, 'bridge-v1'), { recursive: true });
  await fs.writeFile(
    path.join(h.storage, 'bridge-v1', 'bridge.json'),
    JSON.stringify({ enabled: false }),
  );
  assert.equal(await h.manager().ensure(), 'disabled');
  assert.equal(h.writes.length, 0);
});
