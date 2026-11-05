import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostIdentity, serverAddress } from '../hostIdentity';

const fingerprint = 'SHA256:' + 'A'.repeat(43);
const prompt = [
  "The authenticity of host '[server.example]:8002 ([192.0.2.1]:8002)' can't be established.",
  'ED25519 key fingerprint is ' + fingerprint + '.',
  'This key is not known by any other names.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
].join('\n');

test('host identity preserves the session fingerprint and key type for LF and CRLF requests', () => {
  for (const value of [prompt, prompt.replaceAll('\n', '\r\n')]) {
    assert.deepEqual(parseHostIdentity(value, fingerprint), {
      keyType: 'ED25519',
      fingerprint,
    });
  }
});

test('host identity uses the original request when the session fingerprint is absent or different', () => {
  for (const value of [undefined, 'bad', 'SHA256:' + 'B'.repeat(43)]) {
    assert.equal(parseHostIdentity(prompt, value), undefined);
  }
});

test('host identity rejects unrelated, ambiguous, and oversized confirmation text', () => {
  const keyLine = 'ED25519 key fingerprint is ' + fingerprint + '.\n';
  for (const value of [
    'OTP code: ' + fingerprint,
    prompt.replace("The authenticity of host '", 'Unrecognized request: '),
    prompt.replace(keyLine, keyLine + keyLine),
    prompt.replace(keyLine, keyLine + 'SHA256:' + 'B'.repeat(43) + '\n'),
    prompt.replace(keyLine, keyLine + 'x'.repeat(8192)),
    prompt.replace('(yes/no/[fingerprint])?', '(yes/no)?'),
  ])
    assert.equal(parseHostIdentity(value, fingerprint), undefined);
});

test('host identity handles a wrapped fingerprint line and other standard key types', () => {
  for (const keyType of ['ED25519', 'ECDSA', 'RSA']) {
    const value = prompt.replace(
      'ED25519 key fingerprint is ',
      keyType + ' key fingerprint is\n',
    );
    assert.deepEqual(parseHostIdentity(value, fingerprint), {
      keyType,
      fingerprint,
    });
  }
});

test('server addresses retain the actual port and disambiguate IPv6', () => {
  assert.equal(
    serverAddress({ host: 'server.example', port: '8002', user: 'user' }),
    'server.example:8002',
  );
  assert.equal(
    serverAddress({ host: '2001:db8::1', port: '2222', user: 'user' }),
    '[2001:db8::1]:2222',
  );
  assert.equal(
    serverAddress({ host: '[2001:db8::1]', port: '22', user: 'user' }),
    '[2001:db8::1]:22',
  );
});
