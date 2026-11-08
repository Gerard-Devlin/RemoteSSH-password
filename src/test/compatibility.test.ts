import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  WINDOWS_SSH_PROFILES,
  windowsSSHProfile,
  windowsSSHProfileById,
} from '../compatibility';

test('Windows OpenSSH profiles keep unique hashes, versions, and filters', () => {
  assert.ok(WINDOWS_SSH_PROFILES.length >= 4);
  assert.equal(
    new Set(WINDOWS_SSH_PROFILES.map((profile) => profile.id)).size,
    WINDOWS_SSH_PROFILES.length,
  );
  assert.equal(
    new Set(WINDOWS_SSH_PROFILES.map((profile) => profile.sha256)).size,
    WINDOWS_SSH_PROFILES.length,
  );
  for (const profile of WINDOWS_SSH_PROFILES) {
    assert.match(profile.sha256, /^[a-f0-9]{64}$/);
    assert.ok(profile.versionMarker.startsWith('OpenSSH_for_Windows_'));
    assert.ok(profile.logVerbose.includes('ssh_packet_read_poll2():'));
    assert.ok(profile.logVerbose.includes('read_passphrase():'));
  }
});

test('Windows OpenSSH profile selection requires both the pinned hash and version', () => {
  const profile = windowsSSHProfileById('openssh-9.8p2');
  assert.ok(profile);
  assert.equal(
    windowsSSHProfile(
      profile.sha256,
      'OpenSSH_for_Windows_9.8p2 Win32-OpenSSH-GitHub',
    )?.id,
    profile.id,
  );
  assert.equal(
    windowsSSHProfile(profile.sha256, 'OpenSSH_for_Windows_9.5p2'),
    undefined,
  );
  assert.equal(
    windowsSSHProfile('0'.repeat(64), profile.versionMarker),
    undefined,
  );
});
