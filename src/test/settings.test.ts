import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  managedBridgeDirectory,
  selectSSHSettings,
  restoration,
} from '../settings';
const currentDir =
  'C:\\profile\\globalStorage\\devlin.remote-ssh-password-memory\\bridge-v1';
const legacyDir =
  'C:\\profile\\globalStorage\\local-tools.remote-ssh-password-memory\\bridge-v1';
const directories = [currentDir, legacyDir];
const legacySSH = legacyDir + '\\ssh.exe';
const systemSSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const customSSH = 'D:\\OpenSSH\\ssh.exe';
const journal = (original: unknown) => ({ bridgePath: legacySSH, original });

test('ordinary SSH settings and unrelated wrappers are preserved', () => {
  const current = { path: customSSH, useLocalServer: false };
  assert.deepEqual(selectSSHSettings(current, systemSSH, directories), {
    original: current,
    realSSH: customSSH,
    migration: 'none',
  });
  assert.equal(
    selectSSHSettings(
      { path: 'D:\\other\\bridge-v1\\ssh.exe' },
      systemSSH,
      directories,
    ).migration,
    'none',
  );
});
test('missing legacy metadata selects Windows OpenSSH and never restores the dead helper', () => {
  const result = selectSSHSettings(
    { path: legacySSH, useLocalServer: true },
    systemSSH,
    directories,
  );
  assert.equal(result.migration, 'fallback');
  assert.equal(result.realSSH, systemSSH);
  assert.deepEqual(result.original, { path: systemSSH, useLocalServer: true });
  assert.deepEqual(
    restoration(
      { path: currentDir + '\\ssh.exe', useLocalServer: true },
      { bridgePath: currentDir + '\\ssh.exe', original: result.original },
    ),
    { path: { value: systemSSH }, useLocalServer: { value: true } },
  );
});
test('valid legacy recovery preserves unset original SSH and local-server values', () => {
  const result = selectSSHSettings(
    { path: legacySSH, useLocalServer: true },
    systemSSH,
    directories,
    journal({}),
  );
  assert.equal(result.migration, 'recovered');
  assert.equal(result.realSSH, systemSSH);
  assert.deepEqual(result.original, {
    path: undefined,
    useLocalServer: undefined,
  });
});
test('valid recovery retains a custom SSH program and later local-server edits', () => {
  const result = selectSSHSettings(
    { path: legacySSH, useLocalServer: false },
    systemSSH,
    directories,
    journal({ path: customSSH, useLocalServer: true }),
  );
  assert.equal(result.realSSH, customSSH);
  assert.deepEqual(result.original, { path: customSSH, useLocalServer: false });
});
test('legacy paths match drive and directory casing without matching other files', () => {
  assert.equal(
    managedBridgeDirectory(legacySSH.toUpperCase(), directories),
    legacyDir,
  );
  assert.equal(
    managedBridgeDirectory(legacyDir + '\\other.exe', directories),
    undefined,
  );
});
test('missing journal can use a recorded real OpenSSH candidate', () => {
  const result = selectSSHSettings(
    { path: legacySSH },
    systemSSH,
    directories,
    undefined,
    { realSSH: customSSH },
  );
  assert.equal(result.migration, 'fallback');
  assert.equal(result.realSSH, customSSH);
  assert.equal(result.original.path, customSSH);
});
test('malformed recovery, wrapper loops and relative candidates fall back safely', () => {
  for (const [recovery, configuration] of [
    [{ bridgePath: customSSH, original: { path: customSSH } }, undefined],
    [journal({ path: legacySSH }), { realSSH: currentDir + '\\ssh.exe' }],
    [journal({ useLocalServer: 'yes' }), { realSSH: 'relative.exe' }],
    [journal({ path: 'relative.exe' }), { realSSH: legacySSH }],
  ]) {
    const result = selectSSHSettings(
      { path: legacySSH },
      systemSSH,
      directories,
      recovery,
      configuration,
    );
    assert.equal(result.migration, 'fallback');
    assert.equal(result.realSSH, systemSSH);
  }
});
test('lost current helper state uses the same recovery rules', () => {
  const result = selectSSHSettings(
    { path: currentDir + '\\ssh.exe' },
    systemSSH,
    directories,
  );
  assert.equal(result.migration, 'fallback');
  assert.equal(result.original.path, systemSSH);
});
