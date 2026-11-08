import { suffix, realSSH, nullDevice } from './platform.mjs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CredentialCore, keyFor } = require('../dist/core.js');
const { windowsSSHProfile } = require('../dist/compatibility.js');
const root = process.cwd(),
  dir = path.join(root, '.test-runtime', randomUUID());
await fs.mkdir(dir, { recursive: true });
for (const n of [
  'ssh' + suffix,
  'scp' + suffix,
  'askpass' + suffix,
  'broker' + suffix,
])
  await fs.copyFile(path.join(root, 'bin', n), path.join(dir, n));
const realSSHHash = createHash('sha256')
  .update(await fs.readFile(realSSH))
  .digest('hex');
let windowsProfile;
if (process.platform === 'win32') {
  const version = spawnSync(realSSH, ['-V'], { encoding: 'utf8' });
  const label = (version.stdout || '') + (version.stderr || '');
  windowsProfile = windowsSSHProfile(realSSHHash, label);
  assert.ok(
    windowsProfile,
    'integration OpenSSH is not in the supported profile allowlist',
  );
}
await fs.writeFile(
  path.join(dir, 'bridge.json'),
  JSON.stringify({
    realSSH,
    realSSHHash,
    sshProfile: windowsProfile?.id,
    logVerbose: windowsProfile?.logVerbose,
    realSCP: path.join(path.dirname(realSSH), 'scp' + suffix),
    enabled: true,
  }),
);
const children = [];
const results = [];
const secrets = new Map();
let prompts = 0,
  trusts = 0,
  changed = 0;
let answer;
let allowTrust = true;
let canceled = false;
let remember = true;
let answerDelay = 0;
let expected;
const secret = 'fixture-' + randomUUID() + '-中文! "&$%|\\';
expected = secret;
answer = secret;
const secretStrings = [secret];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function proc(exe, args = [], opts = {}) {
  const p = spawn(exe, args, {
    cwd: dir,
    windowsHide: true,
    stdio: 'pipe',
    ...opts,
  });
  children.push(p);
  p.stdin.on('error', () => {});
  return p;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('fixture timeout');
    await sleep(20);
  }
}
async function server(config = {}) {
  const p = proc(path.join(root, 'bin', 'testserver' + suffix));
  let ready;
  const events = [];
  let stderr = '';
  p.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: p.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    events.push(m);
    if (m.type === 'ready') ready = m;
  });
  p.stdin.write(JSON.stringify({ password: expected, ...config }) + '\n');
  await until(() => ready);
  return {
    p,
    ready,
    events,
    port: ready.address.split(':').at(-1),
    async password(value) {
      p.stdin.write(JSON.stringify({ password: value }) + '\n');
      await sleep(50);
    },
  };
}
function makeCore() {
  return new CredentialCore(
    {
      get: async (k) => secrets.get(k),
      store: async (k, v) => secrets.set(k, v),
      delete: async (k) => secrets.delete(k),
    },
    {
      ask: async (t, p, cacheable, failed) => {
        prompts++;
        if (answerDelay) await sleep(answerDelay);
        return canceled
          ? { canceled: true }
          : { value: answer, remember: cacheable && remember, source: 'input' };
      },
      trust: async () => {
        trusts++;
        return allowTrust ? { value: 'yes' } : { canceled: true };
      },
      changed: () => changed++,
      cancel: () => {},
    },
    async () => {},
  );
}
async function broker(extraEnv = {}) {
  const core = makeCore(),
    p = proc(path.join(dir, 'broker' + suffix), [], {
      env: { ...process.env, ...extraEnv },
    });
  p.on('close', () => core.clear());
  let route;
  let errors = 0;
  const messages = [];
  p.stderr.on('data', () => errors++);
  createInterface({ input: p.stdout }).on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.type === 'ready') {
      route = m.prompt;
      return;
    }
    messages.push({
      type: m.type,
      kind: m.kind,
      verified: m.verified,
      method: m.method,
      failed: m.failed,
    });
    try {
      const reply = await core.handle(m);
      if (m.id && p.stdin.writable)
        p.stdin.write(
          JSON.stringify({ type: 'answer', id: m.id, reply }) + '\n',
        );
    } catch {
      errors++;
    }
  });
  await until(() => route);
  return {
    p,
    core,
    route,
    messages,
    get errors() {
      return errors;
    },
  };
}
const config = path.join(dir, 'ssh_config'),
  known = path.join(dir, 'known_hosts');
await fs.writeFile(config, '');
await fs.writeFile(known, '');
function base(port, opts = []) {
  return [
    '-F',
    config,
    '-o',
    'UserKnownHostsFile=' + known,
    '-o',
    'GlobalKnownHostsFile=' + nullDevice,
    '-o',
    'StrictHostKeyChecking=ask',
    '-o',
    'PreferredAuthentications=password',
    '-o',
    'PubkeyAuthentication=no',
    '-o',
    'ConnectTimeout=3',
    '-p',
    port,
    ...opts,
    'fixture@127.0.0.1',
  ];
}
async function run(exe, args, route, input = '', extraEnv = {}) {
  const p = proc(exe, args, {
    env: {
      ...process.env,
      ...extraEnv,
      SSHPM_WINDOW_PIPE: route ?? '',
    },
  });
  let stdout = '',
    stderr = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stderr.on('data', (d) => (stderr += d));
  p.stdin.end(input);
  const timer = setTimeout(() => p.kill(), 20000);
  const code = await new Promise((r, j) => {
    p.on('error', j);
    p.on('close', r);
  });
  clearTimeout(timer);
  for (const s of secretStrings) {
    assert.ok(
      !stdout.includes(s) && !stderr.includes(s),
      'secret leaked to process output',
    );
  }
  return { code, stdout, stderr };
}
const ssh = (srv, b, args = [], input = '') =>
  run(
    path.join(dir, 'ssh' + suffix),
    [...base(srv.port), ...args],
    b?.route,
    input,
  );
async function check(name, f) {
  try {
    await f();
    results.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e.message) });
    throw e;
  }
}
try {
  const s = await server(),
    b = await broker();
  await sleep(1200);
  await check('ssh -V is byte-compatible', async () => {
    const a = await run(realSSH, ['-V']),
      v = await run(path.join(dir, 'ssh' + suffix), ['-V']);
    assert.equal(v.code, a.code);
    assert.equal(v.stderr, a.stderr);
  });
  await check('ssh -G is byte-compatible', async () => {
    const a = await run(realSSH, ['-G', ...base(s.port)]),
      v = await run(path.join(dir, 'ssh' + suffix), ['-G', ...base(s.port)]);
    assert.equal(v.stdout, a.stdout);
  });
  await check('first trust + password + authenticated commit', async () => {
    const r = await ssh(s, b, ['fixture']);
    if (r.code !== 0) console.log(r.stderr);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'fixture-ok\n');
    assert.equal(trusts, 1);
    assert.equal(prompts, 1);
    assert.equal(secrets.size, 1, r.stderr);
    assert.ok(b.messages.some((m) => m.kind === 'password' && m.verified));
  });
  await check('reconnect uses saved password without prompt', async () => {
    const n = prompts;
    assert.equal((await ssh(s, b, ['fixture'])).code, 0);
    assert.equal(prompts, n);
  });
  await check(
    'detached local server selects the broker without an inherited route',
    async () => {
      const instance = '4242424242',
        b2 = await broker({ VSCODE_PID: instance }),
        n = prompts,
        r = await run(
          path.join(dir, 'ssh' + suffix),
          [...base(s.port), 'fixture'],
          '',
          '',
          { VSCODE_PID: instance },
        );
      assert.equal(r.code, 0);
      assert.equal(prompts, n);
      b2.p.stdin.end();
    },
  );
  await check(
    'stale inherited route recovers within the same VS Code instance',
    async () => {
      const instance = '4343434343',
        b2 = await broker({ VSCODE_PID: instance }),
        n = prompts,
        r = await run(
          path.join(dir, 'ssh' + suffix),
          [...base(s.port), 'fixture'],
          '\\\\.\\pipe\\sshpm-stale-' + randomUUID(),
          '',
          { VSCODE_PID: instance },
        );
      assert.equal(r.code, 0);
      assert.equal(prompts, n);
      assert.ok(b2.messages.some((m) => m.kind === 'password'));
      b2.p.stdin.end();
    },
  );
  await check('exit code and standard input preserved', async () => {
    assert.equal((await ssh(s, b, ['exit-7'])).code, 7);
    const r = await ssh(s, b, ['echo-stdin'], 'echo test 中文\n');
    assert.equal(r.stdout, 'echo test 中文\n');
  });
  await check('long and unterminated remote stderr is preserved', async () => {
    const r = await ssh(s, b, ['stderr-long']);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.endsWith('z'.repeat(200000) + '\n尾部-without-newline'));
  });
  await check('SCP uploads via wrapper SSH/SFTP', async () => {
    const source = path.join(dir, 'upload.txt');
    await fs.writeFile(source, 'scp-test');
    const args = [
      '-v',
      '-F',
      config,
      '-o',
      'UserKnownHostsFile=' + known,
      '-o',
      'GlobalKnownHostsFile=' + nullDevice,
      '-o',
      'StrictHostKeyChecking=ask',
      '-o',
      'PreferredAuthentications=password',
      '-P',
      s.port,
      source,
      'fixture@127.0.0.1:upload.txt',
    ];
    const r = await run(path.join(dir, 'scp' + suffix), args, b.route);
    if (r.code !== 0) console.log(r.stderr, JSON.stringify(s.events));
    assert.equal(r.code, 0);
    assert.equal(
      await fs.readFile(
        path.join(os.tmpdir(), 'sshpm-sftp-fixture', 'upload.txt'),
        'utf8',
      ),
      'scp-test',
    );
  });
  await check(
    'rejected saved password prompts and replaces after success',
    async () => {
      expected = 'changed-' + randomUUID();
      secretStrings.push(expected);
      answer = expected;
      await s.password(expected);
      const n = prompts;
      assert.equal((await ssh(s, b, ['fixture'])).code, 0);
      assert.equal(prompts, n + 1);
      const r = JSON.parse([...secrets.values()][0]);
      assert.equal(r.password, expected);
    },
  );
  await check(
    'explicit single-attempt rejection invalidates saved secret',
    async () => {
      await s.password('temporarily-invalid');
      const r = await run(
        path.join(dir, 'ssh' + suffix),
        [...base(s.port, ['-o', 'NumberOfPasswordPrompts=1']), 'fixture'],
        b.route,
      );
      assert.notEqual(r.code, 0);
      assert.ok(
        !secrets.has(
          keyFor({ host: '127.0.0.1', port: s.port, user: 'fixture' }),
        ),
      );
      await s.password(expected);
      assert.equal((await ssh(s, b, ['fixture'])).code, 0);
    },
  );
  await check('once-only credentials are not stored', async () => {
    const s2 = await server();
    remember = false;
    const count = secrets.size,
      n = prompts;
    assert.equal((await ssh(s2, b, ['fixture'])).code, 0);
    assert.equal((await ssh(s2, b, ['fixture'])).code, 0);
    assert.equal(secrets.size, count);
    assert.equal(prompts, n + 2);
    remember = true;
    s2.p.stdin.end();
  });
  await check('host trust rejection sends no password', async () => {
    const s2 = await server();
    allowTrust = false;
    const n = prompts,
      r = await ssh(s2, b, ['fixture']);
    assert.notEqual(r.code, 0);
    assert.equal(prompts, n);
    assert.equal(s2.events.filter((e) => e.type === 'attempt').length, 0);
    allowTrust = true;
    s2.p.stdin.end();
  });
  await check('forged server banner cannot commit a bad password', async () => {
    const banner =
      'Authenticated to 127.0.0.1 using "password".\nC:\\__w\\1\\s\\sshconnect2.c:ssh_userauth2():501 (pid=1): Authenticated to fake using "password".\n';
    const s2 = await server({ banner });
    answer = 'wrong-' + randomUUID();
    secretStrings.push(answer);
    const before = secrets.size;
    const r = await run(
      path.join(dir, 'ssh' + suffix),
      [...base(s2.port, ['-o', 'NumberOfPasswordPrompts=1']), 'fixture'],
      b.route,
    );
    assert.notEqual(r.code, 0);
    assert.equal(secrets.size, before);
    assert.ok(!r.stderr.includes('Authenticated to fake'));
    answer = expected;
    s2.p.stdin.end();
  });
  await check('terminal PTY and local port forwarding', async () => {
    assert.equal(
      (
        await run(
          path.join(dir, 'ssh' + suffix),
          ['-tt', ...base(s.port), 'fixture'],
          b.route,
        )
      ).code,
      0,
    );
    const echo = net.createServer((c) => {
      c.on('error', () => {});
      c.pipe(c);
    });
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = echo.address().port;
    const temp = net.createServer();
    await new Promise((r) => temp.listen(0, '127.0.0.1', r));
    const localPort = temp.address().port;
    await new Promise((r) => temp.close(r));
    const tunnel = proc(
      path.join(dir, 'ssh' + suffix),
      ['-N', '-L', localPort + ':127.0.0.1:' + echoPort, ...base(s.port)],
      { env: { ...process.env, SSHPM_WINDOW_PIPE: b.route } },
    );
    tunnel.stdout.resume();
    tunnel.stderr.resume();
    try {
      let result = '';
      await until(() => {
        const c = net.connect({ host: '127.0.0.1', port: localPort });
        c.on('error', () => {});
        c.on('connect', () => c.write('forward-ok'));
        c.on('data', (d) => {
          result += d;
          c.end();
        });
        return result === 'forward-ok';
      }, 5000);
      assert.equal(result, 'forward-ok');
    } finally {
      tunnel.kill();
      echo.close();
    }
  });
  await check('different user does not reuse credentials', async () => {
    const n = prompts;
    const args = base(s.port);
    args[args.length - 1] = 'other@127.0.0.1';
    assert.equal(
      (await run(path.join(dir, 'ssh' + suffix), [...args, 'fixture'], b.route))
        .code,
      0,
    );
    assert.equal(prompts, n + 1);
  });
  await check('cancel never commits a password', async () => {
    const s2 = await server();
    canceled = true;
    const count = secrets.size,
      oldPrompts = prompts;
    assert.notEqual((await ssh(s2, b, ['fixture'])).code, 0);
    assert.equal(secrets.size, count);
    assert.equal(prompts, oldPrompts + 1);
    assert.equal(s2.events.filter((e) => e.type === 'attempt').length, 0);
    canceled = false;
    s2.p.stdin.end();
  });
  await check('broker restart reads previously saved credential', async () => {
    b.p.stdin.end();
    await sleep(200);
    const b2 = await broker();
    const n = prompts;
    assert.equal((await ssh(s, b2, ['fixture'])).code, 0);
    assert.equal(prompts, n);
    b2.p.stdin.end();
  });
  await check('concurrent windows coalesce first password entry', async () => {
    const s2 = await server();
    await fs.appendFile(
      known,
      '[127.0.0.1]:' + s2.port + ' ' + s2.ready.key + '\n',
    );
    const b1 = await broker(),
      b2 = await broker();
    await sleep(1200);
    answerDelay = 800;
    const n = prompts;
    const runs = await Promise.all([
      ssh(s2, b1, ['fixture']),
      ssh(s2, b2, ['fixture']),
    ]);
    assert.ok(runs.every((r) => r.code === 0));
    assert.equal(prompts, n + 1);
    answerDelay = 0;
    b1.p.stdin.end();
    b2.p.stdin.end();
    s2.p.stdin.end();
  });
  await check(
    'disconnect during password authentication keeps saved secret',
    async () => {
      const s2 = await server(),
        b2 = await broker();
      assert.equal((await ssh(s2, b2, ['fixture'])).code, 0);
      const key = keyFor({ host: '127.0.0.1', port: s2.port, user: 'fixture' }),
        saved = secrets.get(key);
      s2.p.stdin.write(
        JSON.stringify({ password: expected, delayPasswordMS: 10000 }) + '\n',
      );
      await until(() => s2.events.some((e) => e.type === 'updated'));
      const attempts = s2.events.filter((e) => e.type === 'attempt').length;
      const pending = ssh(s2, b2, ['fixture']);
      await until(
        () => s2.events.filter((e) => e.type === 'attempt').length > attempts,
      );
      s2.p.kill();
      assert.notEqual((await pending).code, 0);
      assert.equal(secrets.get(key), saved);
      b2.p.stdin.end();
    },
  );
  await check(
    'handshake timeout does not prompt or delete credentials',
    async () => {
      const peers = [];
      const idle = net.createServer((c) => {
        peers.push(c);
        c.on('error', () => {});
      });
      await new Promise((r) => idle.listen(0, '127.0.0.1', r));
      const b2 = await broker(),
        before = [...secrets],
        n = prompts;
      try {
        const r = await run(
          path.join(dir, 'ssh' + suffix),
          [
            ...base(String(idle.address().port), ['-o', 'ConnectTimeout=1']),
            'fixture',
          ],
          b2.route,
        );
        assert.notEqual(r.code, 0);
        assert.equal(prompts, n);
        assert.deepEqual([...secrets], before);
      } finally {
        for (const c of peers) c.destroy();
        idle.close();
        b2.p.stdin.end();
      }
    },
  );
  await check(
    'closing a session while input is pending cannot save',
    async () => {
      const s2 = await server(),
        b2 = await broker();
      await fs.appendFile(
        known,
        '[127.0.0.1]:' + s2.port + ' ' + s2.ready.key + '\n',
      );
      answerDelay = 600;
      const before = secrets.size,
        n = prompts;
      const p = proc(
        path.join(dir, 'ssh' + suffix),
        [...base(s2.port), 'fixture'],
        {
          env: { ...process.env, SSHPM_WINDOW_PIPE: b2.route },
        },
      );
      p.stdout.resume();
      p.stderr.resume();
      await until(() => prompts > n);
      p.kill();
      await until(() => b2.messages.some((m) => m.type === 'end'));
      await sleep(800);
      assert.equal(secrets.size, before);
      answerDelay = 0;
      b2.p.stdin.end();
      s2.p.stdin.end();
    },
  );
  await check('broker crash during input fails closed', async () => {
    const s2 = await server(),
      b2 = await broker();
    await fs.appendFile(
      known,
      '[127.0.0.1]:' + s2.port + ' ' + s2.ready.key + '\n',
    );
    answerDelay = 500;
    const before = secrets.size,
      n = prompts;
    const p = ssh(s2, b2, ['fixture']);
    await until(() => prompts > n);
    b2.p.kill();
    assert.notEqual((await p).code, 0);
    await sleep(700);
    assert.equal(secrets.size, before);
    answerDelay = 0;
    s2.p.stdin.end();
  });
  await check(
    'unrelated process cannot request credentials from window pipe',
    async () => {
      const b2 = await broker();
      let data = '';
      const n = prompts;
      await new Promise((resolve, reject) => {
        const c = net.connect(b2.route);
        const timeout = setTimeout(() => {
          c.destroy();
          reject(new Error('pipe did not reject unauthorized client'));
        }, 3000);
        c.on('error', () => {});
        c.on('connect', () =>
          c.write(
            JSON.stringify({
              id: 'attack',
              type: 'open',
              target: { host: '127.0.0.1', port: s.port, user: 'fixture' },
            }) + '\n',
          ),
        );
        c.on('data', (d) => (data += d));
        c.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      assert.equal(data, '');
      assert.equal(prompts, n);
      b2.p.stdin.end();
    },
  );
  await check(
    'unknown route fails closed without a VS Code instance identity',
    async () => {
      const b2 = await broker({ VSCODE_PID: '' }),
        n = prompts;
      const r = await run(
        path.join(dir, 'ssh' + suffix),
        [...base(s.port, ['-o', 'BatchMode=yes']), 'fixture'],
        '\\\\.\\pipe\\sshpm-absent-' + randomUUID(),
        '',
        { VSCODE_PID: '' },
      );
      assert.notEqual(r.code, 0);
      assert.equal(prompts, n);
      b2.p.stdin.end();
    },
  );
  await check(
    'disabled bridge and hash mismatch both pass through',
    async () => {
      const b2 = await broker(),
        cfgFile = path.join(dir, 'bridge.json'),
        cfg = JSON.parse(await fs.readFile(cfgFile, 'utf8')),
        n = prompts;
      const args = [...base(s.port, ['-o', 'BatchMode=yes']), 'fixture'];
      try {
        const real = await run(realSSH, args);
        for (const change of [
          { enabled: false },
          { realSSHHash: 'unrecognized-build' },
        ]) {
          await fs.writeFile(cfgFile, JSON.stringify({ ...cfg, ...change }));
          const r = await run(path.join(dir, 'ssh' + suffix), args, b2.route);
          assert.equal(r.code, real.code);
          assert.equal(r.stderr, real.stderr);
          assert.equal(prompts, n);
        }
      } finally {
        await fs.writeFile(cfgFile, JSON.stringify(cfg));
        b2.p.stdin.end();
      }
    },
  );
  await check('changed host key fails before providing password', async () => {
    const port = s.port;
    s.p.stdin.end();
    await sleep(300);
    const s3 = await server({ port });
    const b3 = await broker();
    const n = prompts,
      r = await ssh(s3, b3, ['fixture']);
    assert.notEqual(r.code, 0);
    assert.equal(prompts, n);
    assert.equal(s3.events.filter((e) => e.type === 'attempt').length, 0);
    await check(
      'trusted changed fingerprint still requires new password input',
      async () => {
        const text = await fs.readFile(known, 'utf8');
        await fs.writeFile(
          known,
          text
            .split('\n')
            .filter((l) => !l.startsWith('[127.0.0.1]:' + port + ' '))
            .join('\n') +
            '\n[127.0.0.1]:' +
            port +
            ' ' +
            s3.ready.key +
            '\n',
        );
        const warnings = changed;
        assert.equal((await ssh(s3, b3, ['fixture'])).code, 0);
        assert.equal(prompts, n + 1);
        assert.equal(changed, warnings + 1);
      },
    );
    b3.p.stdin.end();
    s3.p.stdin.end();
  });
  await check(
    'unavailable extension preserves ordinary OpenSSH behavior',
    async () => {
      for (const c of children)
        if (c.spawnfile.endsWith('broker' + suffix)) c.stdin.end();
      await sleep(300);
      const args = [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=1',
        '-p',
        '1',
        '127.0.0.1',
      ];
      const real = await run(realSSH, args),
        wrapped = await run(path.join(dir, 'ssh' + suffix), args);
      assert.equal(wrapped.code, real.code);
      assert.equal(wrapped.stderr, real.stderr);
    },
  );
  await check('no password remains in runtime files', async () => {
    async function scan(p) {
      for (const e of await fs.readdir(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) await scan(f);
        else if (!e.name.endsWith('.exe')) {
          const data = await fs.readFile(f, 'utf8');
          for (const s of secretStrings)
            assert.ok(!data.includes(s), 'password in runtime file');
        }
      }
    }
    await scan(dir);
  });
} finally {
  for (const p of children) {
    p.stdin?.end();
    p.kill();
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(
    process.env.SSHPM_INTEGRATION_RESULT ||
      path.join(root, 'artifacts', 'integration-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        results,
      },
      null,
      2,
    ),
  );
}
