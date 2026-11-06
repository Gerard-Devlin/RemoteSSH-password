import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CredentialCore,
  Target,
  Reply,
  Message,
  keyFor,
  revocationKey,
} from '../core';
import { restoration } from '../settings';
const target: Target = { host: 'example.test', port: '22', user: 'alice' };
const fp = 'SHA256:' + 'A'.repeat(43);
function harness(secrets = new Map<string, string>()) {
  let prompts = 0;
  let changed = 0;
  let answer: Reply = { value: 'synthetic-中文-$ & " \\', remember: true };
  let resolve: ((r: Reply) => void) | undefined;
  let defer = false;
  const core = new CredentialCore(
    {
      get: async (k) => secrets.get(k),
      store: async (k, v) => {
        secrets.set(k, v);
      },
      delete: async (k) => {
        secrets.delete(k);
      },
    },
    {
      ask: async () => {
        prompts++;
        return defer ? new Promise((r) => (resolve = r)) : answer;
      },
      trust: async () => ({ canceled: true }),
      changed: () => changed++,
      cancel: () => {},
    },
    async () => {},
  );
  const open = async (id = 's', t = target) =>
    core.handle({ type: 'open', session: id, target: t });
  const ask = (id = 's', extra: Partial<Message> = {}) =>
    core.handle({
      type: 'ask',
      session: id,
      kind: 'password',
      verified: true,
      fingerprint: fp,
      ...extra,
    });
  return {
    core,
    secrets,
    open,
    ask,
    get prompts() {
      return prompts;
    },
    get changed() {
      return changed;
    },
    set answer(r: Reply) {
      answer = r;
    },
    set defer(v: boolean) {
      defer = v;
    },
    release(r: Reply) {
      resolve!(r);
    },
  };
}
test('save only after authenticated password; reopen reuses encrypted-store adapter', async () => {
  const h = harness();
  await h.open();
  const r = await h.ask();
  assert.equal(h.secrets.size, 0);
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(h.secrets.size, 1);
  await h.open('s2');
  assert.equal((await h.ask('s2')).value, r.value);
  assert.equal(h.prompts, 1);
});
test('once only is never persisted', async () => {
  const h = harness();
  h.answer = { value: 'once', remember: false };
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  await h.open('other');
  await h.ask('other');
  assert.equal(h.prompts, 2);
  assert.equal(h.secrets.size, 0);
});
test('key includes effective host, port, case-sensitive user', () => {
  assert.notEqual(keyFor(target), keyFor({ ...target, port: '2222' }));
  assert.notEqual(keyFor(target), keyFor({ ...target, user: 'Alice' }));
  assert.equal(keyFor(target), keyFor({ ...target, host: 'EXAMPLE.TEST' }));
});
test('failed saved secret deleted; replacement saved only on success', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  await h.open('two');
  assert.equal((await h.ask('two')).source, 'saved');
  h.answer = { value: 'replacement', remember: true };
  await h.ask('two', { failed: true });
  assert.equal(h.secrets.size, 0);
  await h.core.handle({ type: 'success', session: 'two', method: 'password' });
  assert.equal(
    JSON.parse(h.secrets.get(keyFor(target))!).password,
    'replacement',
  );
});
test('disconnect is not rejection', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  await h.open('two');
  await h.ask('two');
  await h.core.handle({ type: 'end', session: 'two' });
  assert.equal(h.secrets.size, 1);
});
test('fingerprint mismatch requires input', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  await h.open('two');
  const r = await h.ask('two', { fingerprint: 'SHA256:' + 'B'.repeat(43) });
  assert.equal(r.source, 'input');
  assert.equal(h.changed, 1);
});
test('manual, OTP, key passphrase and unverified prompts cannot save', async () => {
  for (const extra of [
    { kind: 'manual' },
    { verified: false },
    { fingerprint: 'bad' },
  ]) {
    const h = harness();
    await h.open();
    await h.ask('s', extra);
    await h.core.handle({ type: 'success', session: 's', method: 'password' });
    assert.equal(h.secrets.size, 0);
  }
});
test('non-password authentication success cannot commit candidate', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({
    type: 'success',
    session: 's',
    method: 'keyboard-interactive',
  });
  assert.equal(h.secrets.size, 0);
});
test('cancel is not an empty password or stored credential', async () => {
  const h = harness();
  h.answer = { canceled: true };
  await h.open();
  assert.equal((await h.ask()).canceled, true);
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(h.secrets.size, 0);
});
test('concurrent same target prompts are coalesced', async () => {
  const h = harness();
  h.defer = true;
  await h.open('a');
  await h.open('b');
  const a = h.ask('a'),
    b = h.ask('b');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.prompts, 1);
  h.release({ value: 'shared', remember: true });
  assert.equal((await a).value, (await b).value);
});
test('ended session never commits delayed UI answer', async () => {
  const h = harness();
  h.defer = true;
  await h.open();
  const p = h.ask();
  await new Promise((r) => setImmediate(r));
  await h.core.handle({ type: 'end', session: 's' });
  h.release({ value: 'late', remember: true });
  assert.equal((await p).canceled, true);
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(h.secrets.size, 0);
});
test('forget invalidates pending candidates', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.forget(target);
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(await h.core.read(target), undefined);
});
test('restore preserves user modifications and absent original values', () => {
  const state = { original: {}, bridgePath: 'bridge' };
  assert.deepEqual(
    restoration({ path: 'bridge', useLocalServer: true }, state),
    { path: { value: undefined }, useLocalServer: { value: undefined } },
  );
  assert.deepEqual(
    restoration({ path: 'new-ssh', useLocalServer: false }, state),
    {},
  );
});

test('manual challenge clears a previous password candidate', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.ask('s', { kind: 'manual' });
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(h.secrets.size, 0);
});
test('external deletion invalidates another window candidate', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  h.core.invalidate(keyFor(target));
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(h.secrets.size, 0);
});
test('a session target cannot be reopened and switched', async () => {
  const h = harness();
  await h.open();
  assert.equal(
    (await h.open('s', { ...target, user: 'mallory' })).canceled,
    true,
  );
});
test('saved reads that finish after session close are not released', async () => {
  let resolve!: (v: string) => void;
  const record = JSON.stringify({
    target,
    fingerprint: fp,
    password: 'not-released',
    ticket: 'id',
    updated: '',
  });
  const core = new CredentialCore(
    {
      get: (k) =>
        k.startsWith('revocation.')
          ? Promise.resolve(undefined)
          : new Promise<string>((r) => (resolve = r)),
      store: async () => {},
      delete: async () => {},
    },
    {
      ask: async () => ({ canceled: true }),
      trust: async () => ({ canceled: true }),
      changed: () => {},
      cancel: () => {},
    },
    async () => {},
  );
  await core.handle({ type: 'open', session: 's', target });
  const p = core.handle({
    type: 'ask',
    session: 's',
    kind: 'password',
    verified: true,
    fingerprint: fp,
  });
  await new Promise((r) => setImmediate(r));
  await core.handle({ type: 'end', session: 's' });
  resolve(record);
  assert.equal((await p).canceled, true);
});

test('forget revokes a candidate received by another process', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  h.secrets.set(revocationKey(keyFor(target)), 'new-revision');
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  assert.equal(await h.core.read(target), undefined);
});
test('a stale success racing forget is never reused', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  const previous = h.secrets.get(keyFor(target))!;
  await h.core.forget(target);
  h.secrets.set(keyFor(target), previous);
  assert.equal(await h.core.read(target), undefined);
});
test('rejected old ticket does not delete a newer successful value', async () => {
  const h = harness();
  await h.open('a');
  await h.ask('a');
  await h.core.handle({ type: 'success', session: 'a', method: 'password' });
  await h.open('b');
  await h.ask('b');
  const updated = JSON.parse(h.secrets.get(keyFor(target))!);
  updated.ticket = 'new-ticket';
  updated.password = 'new-password';
  h.secrets.set(keyFor(target), JSON.stringify(updated));
  await h.core.handle({ type: 'rejected', session: 'b' });
  assert.equal((await h.core.read(target))?.password, 'new-password');
});

test('saved credentials survive runtime disposal and a new core instance', async () => {
  const before = harness();
  await before.open();
  const entered = await before.ask();
  await before.core.handle({
    type: 'success',
    session: 's',
    method: 'password',
  });
  before.core.clear();
  const after = harness(before.secrets);
  await after.open();
  const reused = await after.ask();
  assert.equal(reused.source, 'saved');
  assert.equal(reused.value, entered.value);
  assert.equal(after.prompts, 0);
});

test('manual authentication leaves an existing saved password available', async () => {
  const h = harness();
  await h.open();
  await h.ask();
  await h.core.handle({ type: 'success', session: 's', method: 'password' });
  const saved = h.secrets.get(keyFor(target));
  await h.open('interactive');
  await h.ask('interactive', { kind: 'manual' });
  await h.core.handle({
    type: 'success',
    session: 'interactive',
    method: 'keyboard-interactive',
  });
  assert.equal(h.secrets.get(keyFor(target)), saved);
  await h.open('later');
  assert.equal((await h.ask('later')).source, 'saved');
});
