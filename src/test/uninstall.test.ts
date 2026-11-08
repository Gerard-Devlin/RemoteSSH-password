import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, type ParseError } from 'jsonc-parser';
import {
  removeUninstallState,
  restoreSettings,
  settingsPathForStorage,
  writeUninstallState,
} from '../uninstall';

async function fixture(settings: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sshpm-uninstall-'));
  const storage = path.join(
    root,
    'User',
    'globalStorage',
    'devlin.remote-ssh-password-memory',
  );
  const extension = path.join(root, 'extension');
  const bridgePath = path.join(storage, 'bridge-v2', 'version', 'ssh.exe');
  const settingsPath = path.join(root, 'User', 'settings.json');
  await fs.mkdir(storage, { recursive: true });
  await fs.mkdir(path.dirname(bridgePath), { recursive: true });
  await fs.mkdir(extension, { recursive: true });
  await fs.writeFile(settingsPath, settings);
  await fs.writeFile(
    path.join(path.dirname(bridgePath), 'bridge.json'),
    JSON.stringify({ enabled: true, realSSH: 'C:\\OpenSSH\\ssh.exe' }),
  );
  return { root, storage, extension, bridgePath, settingsPath };
}

test('uninstall derives the profile settings path from global storage', () => {
  const storage =
    process.platform === 'win32'
      ? 'C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\devlin.remote-ssh-password-memory'
      : '/Users/dev/Library/Application Support/Code/User/globalStorage/devlin.remote-ssh-password-memory';
  assert.ok(settingsPathForStorage(storage)?.endsWith('settings.json'));
  assert.equal(settingsPathForStorage('/tmp/storage'), undefined);
});

test('uninstall restores only extension-owned settings and preserves JSONC', async () => {
  const h = await fixture(`{
  // Keep this user comment.
  "editor.fontSize": 16,
  "remote.SSH": {
    "path": ${JSON.stringify('/tmp/initial-ssh')},
    "useLocalServer": false
  }
}
`);
  await writeUninstallState({
    storage: h.storage,
    extensionPath: h.extension,
    bridgePath: h.bridgePath,
    original: { path: '/tmp/initial-ssh', useLocalServer: false },
  });
  assert.ok(await fs.stat(path.join(h.extension, 'uninstall-v1.json')));
  await fs.writeFile(
    h.settingsPath,
    `{
  // Keep this user comment.
  "editor.fontSize": 16,
  "remote.SSH": {
    "path": ${JSON.stringify(h.bridgePath)},
    "useLocalServer": true
  }
}
`,
  );
  const state = JSON.parse(
    await fs.readFile(path.join(h.extension, 'uninstall-v1.json'), 'utf8'),
  );
  assert.equal(await restoreSettings(state), true);
  const updated = await fs.readFile(h.settingsPath, 'utf8');
  assert.ok(updated.includes('// Keep this user comment.'));
  const errors: ParseError[] = [];
  const settings = parse(updated, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.equal(settings['editor.fontSize'], 16);
  assert.deepEqual(settings['remote.SSH'], {
    path: '/tmp/initial-ssh',
    useLocalServer: false,
  });
  await removeUninstallState({
    storage: h.storage,
    extensionPath: h.extension,
  });
  await assert.rejects(fs.stat(path.join(h.extension, 'uninstall-v1.json')));
});

test('bundled uninstall entry point restores settings and disables the bridge', async () => {
  const h = await fixture('{}');
  await fs.writeFile(
    h.settingsPath,
    JSON.stringify({
      'remote.SSH': { path: h.bridgePath, useLocalServer: true },
    }),
  );
  const statePath = path.join(h.root, 'uninstall-state.json');
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      storage: h.storage,
      settingsPath: h.settingsPath,
      bridgePath: h.bridgePath,
      original: { path: '/tmp/original-ssh', useLocalServer: false },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'dist', 'uninstall.js')],
    {
      env: { ...process.env, SSHPM_UNINSTALL_STATE: statePath },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(await fs.readFile(h.settingsPath, 'utf8'));
  assert.deepEqual(settings['remote.SSH'], {
    path: '/tmp/original-ssh',
    useLocalServer: false,
  });
  const bridge = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(h.bridgePath), 'bridge.json'),
      'utf8',
    ),
  );
  assert.equal(bridge.enabled, false);
});

test('uninstall removes originally unset SSH settings without touching later edits', async () => {
  const h = await fixture(`{
  "remote.SSH": {
    "path": ${JSON.stringify('/tmp/managed/bridge-v2/version/ssh')},
    "useLocalServer": true
  }
}
`);
  const state = {
    version: 1 as const,
    storage: h.storage,
    settingsPath: h.settingsPath,
    bridgePath: '/tmp/managed/bridge-v2/version/ssh',
    original: {},
  };
  assert.equal(await restoreSettings(state), true);
  const errors: ParseError[] = [];
  const settings = parse(await fs.readFile(h.settingsPath, 'utf8'), errors, {
    allowTrailingComma: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(settings['remote.SSH'], {});

  await fs.writeFile(
    h.settingsPath,
    JSON.stringify({
      'remote.SSH': { path: 'C:\\Other\\ssh.exe', useLocalServer: false },
    }),
  );
  const before = await fs.readFile(h.settingsPath, 'utf8');
  assert.equal(await restoreSettings(state), false);
  assert.equal(await fs.readFile(h.settingsPath, 'utf8'), before);
});
