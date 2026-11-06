import { suffix, realSSH, nullDevice } from './platform.mjs';
import os from 'node:os';
// Runs the actual compiled extension and native broker with a mocked VS Code API.
// No real VS Code settings, SecretStorage or UI are accessed by this test.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const locale = process.argv[2] ?? 'en';
assert.ok(['en', 'zh-cn'].includes(locale), 'Expected en or zh-cn');
const translations =
  locale === 'zh-cn'
    ? JSON.parse(
        await fs.readFile(
          new URL('../l10n/bundle.l10n.zh-cn.json', import.meta.url),
          'utf8',
        ),
      )
    : {};
const translate = (message, ...args) =>
  (translations[message] ?? message).replace(/\{(\d+)\}/g, (_, i) =>
    String(args[Number(i)]),
  );
const ui = {
  inputs: [],
  choices: [],
  warnings: [],
  information: [],
  errors: [],
  channels: [],
};
let acceptEnable = true,
  acceptDelete = true,
  allowErrors = false,
  chooseDiagnostics = false,
  failSecretReads = false;
let selectCredential = false;
let rememberChoice = true;
const root = process.cwd(),
  tmp = path.join(root, '.test-runtime', 'extension-' + randomUUID());
await fs.mkdir(tmp, { recursive: true });
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
const settings = new Map([
  ['path', realSSH],
  ['useLocalServer', false],
  ['useExecServer', true],
]);
const original = new Map(settings),
  commands = new Map(),
  secrets = new Map(),
  globalState = new Map(),
  configListeners = new Set(),
  secretListeners = new Set();
const results = [],
  children = [],
  messages = [],
  subscriptions = [];
let inputCount = 0,
  trustCount = 0,
  inspection;
const password = 'extension-test-' + randomUUID() + '中文!"&$';
let inputAnswer = password;
class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false };
  }
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
}
const api = {
  version: '1.136.1',
  env: { language: locale },
  l10n: { t: translate },
  ConfigurationTarget: { Global: 1 },
  CancellationTokenSource,
  commands: {
    registerCommand: (name, fn) => {
      commands.set(name, fn);
      return {
        dispose() {
          commands.delete(name);
        },
      };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (k) => settings.get(k),
      inspect: (k) => ({ globalValue: settings.get(k) }),
      update: async (k, v) => {
        if (v === undefined) settings.delete(k);
        else settings.set(k, v);
        for (const f of configListeners)
          f({ affectsConfiguration: (q) => q === 'remote.SSH.' + k });
      },
    }),
    onDidChangeConfiguration: (f) => {
      configListeners.add(f);
      return { dispose: () => configListeners.delete(f) };
    },
  },
  window: {
    createOutputChannel: () => ({
      appendLine: (s) => messages.push(s),
      show() {},
      dispose() {},
    }),
    showInputBox: async (options) => {
      ui.inputs.push(options);
      assert.equal(options.password, true);
      inputCount++;
      return inputAnswer;
    },
    showQuickPick: async (items, options) => {
      ui.choices.push({ items, options });
      if (items.every((item) => typeof item.remember === 'boolean'))
        return items[rememberChoice ? 0 : 1];
      inspection = items;
      return selectCredential ? items[0] : undefined;
    },
    showInformationMessage: async (text, options, ...items) => {
      messages.push(text);
      ui.information.push({ text, options, items });
      return options?.modal && acceptEnable ? items[0] : undefined;
    },
    showWarningMessage: async (text, options, ...items) => {
      messages.push(text);
      ui.warnings.push({ text, options, items });
      if (items.includes(translate('Delete Password')))
        return acceptDelete ? items[0] : undefined;
      if (options?.modal && typeof options.detail === 'string') trustCount++;
      return items[0];
    },
    showErrorMessage: async (text, options, ...items) => {
      ui.errors.push({ text, options, items });
      if (!allowErrors) throw new Error(text);
      return chooseDiagnostics ? items[0] : undefined;
    },
  },
};
const context = {
  extensionPath: root,
  globalStorageUri: { fsPath: path.join(tmp, 'storage') },
  subscriptions,
  secrets: {
    get: async (k) => secrets.get(k),
    store: async (k, v) => {
      secrets.set(k, v);
      for (const f of secretListeners) f({ key: k });
    },
    delete: async (k) => {
      secrets.delete(k);
      for (const f of secretListeners) f({ key: k });
    },
    keys: async () => {
      if (failSecretReads) throw new Error('synthetic storage failure');
      return [...secrets.keys()];
    },
    onDidChange: (f) => {
      secretListeners.add(f);
      return { dispose: () => secretListeners.delete(f) };
    },
  },
  globalState: {
    get: (k, d) => (globalState.has(k) ? globalState.get(k) : d),
    update: async (k, v) => {
      if (v === undefined) globalState.delete(k);
      else globalState.set(k, v);
    },
  },
};
const extensionFile = path.join(root, 'dist', 'extension.js'),
  require = createRequire(extensionFile),
  exports = {};
vm.runInNewContext(
  await fs.readFile(extensionFile, 'utf8'),
  {
    exports,
    require: (n) => (n === 'vscode' ? api : require(n)),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
  },
  { filename: extensionFile },
);
const check = async (name, fn) => {
  await fn();
  results.push({ name, passed: true });
  console.log('PASS ' + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(exe, args, extraEnv = {}) {
  const p = spawn(exe, args, {
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, ...extraEnv },
  });
  children.push(p);
  let stdout = '',
    stderr = '';
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (x) => (stdout += x));
  p.stderr.on('data', (x) => (stderr += x));
  p.stdin.end();
  const t = setTimeout(() => p.kill(), 15000);
  try {
    return {
      code: await new Promise((r, j) => {
        p.on('close', r);
        p.on('error', j);
      }),
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(t);
  }
}
async function reload() {
  exports.deactivate();
  for (const disposable of subscriptions.splice(0)) disposable.dispose();
  await sleep(250);
  await exports.activate(context);
}
try {
  await check(
    'installation automatically starts password memory without a setup dialog',
    async () => {
      await exports.activate(context);
      assert.equal(commands.size, 5);
      assert.equal(settings.get('useLocalServer'), true);
      assert.equal(settings.get('useExecServer'), true);
      assert.ok(settings.get('path').includes('bridge-v2'));
      assert.ok(process.env.SSHPM_WINDOW_PIPE);
      assert.equal(ui.information.filter((m) => m.options?.modal).length, 0);
      const recovery = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(settings.get('path')), 'recovery.json'),
          'utf8',
        ),
      );
      assert.equal(recovery.original.path, original.get('path'));
      assert.equal(recovery.original.useLocalServer, false);
    },
  );
  await check(
    'explicit disable survives reload and explicit enable needs no setup dialog',
    async () => {
      await commands.get('sshPasswordMemory.disable')();
      assert.deepEqual(settings, original);
      await reload();
      assert.deepEqual(settings, original);
      await commands.get('sshPasswordMemory.enable')();
      assert.equal(settings.get('useLocalServer'), true);
      assert.equal(ui.information.filter((m) => m.options?.modal).length, 0);
    },
  );
  await check(
    'missing preview helper is repaired automatically during activation',
    async () => {
      await commands.get('sshPasswordMemory.disable')();
      context.globalStorageUri.fsPath = path.join(
        tmp,
        'legacy-scenario',
        'devlin.remote-ssh-password-memory',
      );
      const missing = path.join(
        tmp,
        'legacy-scenario',
        'local-tools.remote-ssh-password-memory',
        'bridge-v1',
        'ssh' + suffix,
      );
      settings.set('path', missing);
      settings.set('useLocalServer', true);
      await reload();
      assert.ok(
        settings.get('path').startsWith(context.globalStorageUri.fsPath),
      );
      const recovery = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(settings.get('path')), 'recovery.json'),
          'utf8',
        ),
      );
      assert.equal(recovery.original.path, original.get('path'));
      await commands.get('sshPasswordMemory.disable')();
      assert.equal(settings.get('path'), original.get('path'));
      settings.set('useLocalServer', false);
      context.globalStorageUri.fsPath = path.join(tmp, 'active-storage');
      await reload();
      assert.equal(settings.get('useLocalServer'), true);
    },
  );
  await check(
    'storage errors show a localized diagnostics action',
    async () => {
      failSecretReads = true;
      allowErrors = true;
      chooseDiagnostics = true;
      try {
        await commands.get('sshPasswordMemory.manage')();
        const error = ui.errors.at(-1);
        assert.equal(
          error.text,
          locale === 'zh-cn' ? '操作未完成' : 'Could not complete this action',
        );
        assert.equal(
          error.items[0].title,
          locale === 'zh-cn' ? '查看诊断' : 'Show Diagnostics',
        );
        assert.ok(!JSON.stringify(error).includes('synthetic storage failure'));
      } finally {
        failSecretReads = false;
        allowErrors = false;
        chooseDiagnostics = false;
      }
    },
  );
  const fixture = spawn(path.join(root, 'bin', 'testserver' + suffix), [], {
    windowsHide: true,
    stdio: 'pipe',
  });
  children.push(fixture);
  let ready;
  let fixtureUpdates = 0;
  fixture.stderr.resume();
  createInterface({ input: fixture.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'ready') ready = m;
    if (m.type === 'updated') fixtureUpdates++;
  });
  fixture.stdin.write(JSON.stringify({ password }) + '\n');
  for (let i = 0; !ready && i < 250; i++) await sleep(20);
  assert.ok(ready);
  const known = path.join(tmp, 'known_hosts'),
    config = path.join(tmp, 'config');
  await fs.writeFile(known, '');
  await fs.writeFile(config, '');
  const args = [
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
    '-p',
    ready.address.split(':').at(-1),
    'fixture@127.0.0.1',
    'fixture',
  ];
  const bridge = settings.get('path');
  await check(
    'actual extension UI adapters and native bridge commit only after success',
    async () => {
      const r = await run(bridge, args);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, 'fixture-ok\n');
      assert.equal(inputCount, 1);
      assert.equal(trustCount, 1);
      assert.equal(
        [...secrets.keys()].filter((k) => k.startsWith('credential.')).length,
        1,
      );
    },
  );
  await check(
    'actual extension reconnect reuses credential without asking',
    async () => {
      assert.equal((await run(bridge, args)).code, 0);
      assert.equal(inputCount, 1);
    },
  );
  await check(
    'reactivation keeps stored passwords and reconnects through a new broker',
    async () => {
      const before = inputCount;
      const saved = [...secrets.entries()];
      exports.deactivate();
      for (const disposable of subscriptions.splice(0)) disposable.dispose();
      await sleep(1200);
      await exports.activate(context);
      assert.deepEqual([...secrets.entries()], saved);
      assert.equal((await run(bridge, args)).code, 0);
      assert.equal(inputCount, before);
      assert.ok(
        messages.includes(
          translate('A saved password was supplied for this connection.'),
        ),
      );
      assert.ok(
        messages.includes(
          translate(
            'Password saved on this device after a successful sign-in.',
          ),
        ),
      );
    },
  );
  await check(
    'rejected-password guidance asks for another attempt without implying a password reset',
    async () => {
      const replacement = 'replacement-' + randomUUID() + '-中文';
      async function setFixturePassword(value) {
        const before = fixtureUpdates;
        fixture.stdin.write(JSON.stringify({ password: value }) + '\n');
        for (let i = 0; fixtureUpdates === before && i < 250; i++)
          await sleep(20);
        assert.ok(fixtureUpdates > before);
      }
      inputAnswer = replacement;
      await setFixturePassword(replacement);
      const before = inputCount;
      assert.equal((await run(bridge, args)).code, 0);
      assert.equal(inputCount, before + 1);
      assert.equal(
        ui.inputs.at(-1).prompt,
        locale === 'zh-cn'
          ? '服务器未接受该密码，请重新输入。'
          : 'The server rejected the password. Try again.',
      );
      assert.ok(!messages.join('\n').includes(replacement));
      inputAnswer = password;
      await setFixturePassword(password);
      assert.equal((await run(bridge, args)).code, 0);
    },
  );
  await check(
    'credential management lists metadata without revealing password',
    async () => {
      await commands.get('sshPasswordMemory.manage')();
      assert.ok(inspection[0].label.startsWith('fixture@127.0.0.1:'));
      assert.ok(!JSON.stringify(inspection).includes(password));
      assert.ok(!messages.join('\n').includes(password));
    },
  );
  await check(
    'password management works without the newer SecretStorage.keys API',
    async () => {
      const enumerate = context.secrets.keys;
      context.secrets.keys = undefined;
      try {
        await commands.get('sshPasswordMemory.manage')();
        assert.ok(inspection[0].label.startsWith('fixture@127.0.0.1:'));
      } finally {
        context.secrets.keys = enumerate;
      }
    },
  );
  await check(
    'localized UI renders input, persistence, trust, validation, and diagnostics',
    async () => {
      const chinese = locale === 'zh-cn';
      const input = ui.inputs[0];
      assert.ok(
        input.title.startsWith(
          chinese ? 'SSH 密码 · fixture@' : 'SSH password · fixture@',
        ),
      );
      assert.equal(
        input.prompt,
        chinese
          ? '输入后可选择是否记住密码。'
          : 'You can choose whether to remember this password in the next step.',
      );
      assert.equal(
        input.placeHolder,
        chinese ? '请输入服务器密码' : 'Enter server password',
      );
      assert.equal(
        input.validateInput(''),
        chinese ? '请输入内容后再继续。' : 'Enter a response to continue.',
      );
      assert.equal(input.validateInput('safe中文!&'), undefined);
      assert.equal(
        input.validateInput('bad\nvalue'),
        chinese
          ? '输入内容不能包含换行或空字符。'
          : 'Line breaks and null characters are not allowed.',
      );
      assert.equal(
        input.validateInput('汉'.repeat(3000)),
        chinese
          ? '输入内容过长，最多支持 8192 字节。'
          : 'The input is too long. Use no more than 8192 bytes.',
      );
      assert.equal(
        input.validateInput('bad\x00value'),
        chinese
          ? '输入内容不能包含换行或空字符。'
          : 'Line breaks and null characters are not allowed.',
      );
      const persistence = ui.choices.find((x) => x.items[0].remember === true);
      assert.equal(
        persistence.items[0].label,
        chinese ? '记住到本机' : 'Remember on This Device',
      );
      assert.equal(
        persistence.items[1].label,
        chinese ? '仅本次使用' : 'Use Once',
      );
      assert.ok(!persistence.options.title.includes('{0}'));
      assert.equal(
        persistence.options.placeHolder,
        chinese
          ? '选择是否记住此密码'
          : 'Choose whether to remember this password',
      );
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(inspection[0].detail));
      const confirmation = ui.warnings[0];
      assert.equal(
        confirmation.text,
        chinese ? '是否信任此服务器？' : 'Trust this server?',
      );
      assert.equal(
        confirmation.items[0],
        chinese ? '信任并继续连接' : 'Trust and Connect',
      );
      assert.ok(
        confirmation.options.detail.includes(
          (chinese ? '服务器：' : 'Server: ') + ready.address,
        ),
      );
      assert.ok(
        confirmation.options.detail.includes(
          chinese ? '密钥类型：ED25519' : 'Key type: ED25519',
        ),
      );
      assert.ok(
        confirmation.options.detail.includes(
          (chinese ? '指纹：\n' : 'Fingerprint:\n') + ready.fingerprint,
        ),
      );
      assert.ok(
        !confirmation.options.detail.includes('The authenticity of host'),
      );
      assert.ok(!confirmation.options.detail.includes('yes/no/[fingerprint]'));
      assert.ok(!confirmation.options.detail.includes('fixture@'));
      assert.ok(
        inspection[0].detail.startsWith(
          chinese ? '上次登录：' : 'Last sign-in:',
        ),
      );
      await commands.get('sshPasswordMemory.diagnostics')();
      assert.ok(
        messages.some((m) =>
          m.startsWith(
            (chinese ? '平台：' : 'Platform: ') +
              process.platform +
              '/' +
              process.arch,
          ),
        ),
      );
      assert.ok(!messages.some((m) => m.includes(password)));
    },
  );
  async function interactiveServer(config = {}) {
    const child = spawn(path.join(root, 'bin', 'testserver' + suffix), [], {
      windowsHide: true,
      stdio: 'pipe',
    });
    children.push(child);
    child.stderr.resume();
    let ready;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.type === 'ready') ready = m;
    });
    child.stdin.write(
      JSON.stringify({ password, keyboardInteractive: true, ...config }) + '\n',
    );
    for (let i = 0; !ready && i < 250; i++) await sleep(20);
    assert.ok(ready);
    const request = [...args];
    request[request.indexOf('-p') + 1] = ready.address.split(':').at(-1);
    request[request.indexOf('PreferredAuthentications=password')] =
      'PreferredAuthentications=keyboard-interactive';
    return { child, request };
  }
  await check(
    'interactive fixed password is saved after success, reused, and replaced after rejection',
    async () => {
      const before = new Set(secrets.keys()),
        prompts = inputCount;
      const server = await interactiveServer();
      try {
        assert.equal((await run(bridge, server.request)).code, 0);
        assert.equal(inputCount, prompts + 1);
        assert.equal(
          ui.inputs
            .at(-1)
            .title.startsWith(locale === 'zh-cn' ? 'SSH 密码' : 'SSH password'),
          true,
        );
        assert.equal(
          ui.inputs.at(-1).prompt,
          translate(
            'You can choose whether to remember this password in the next step.',
          ),
        );
        const choice = ui.choices.at(-1);
        assert.equal(
          choice.items[0].description,
          translate(
            'For your fixed server password; never choose this for a verification code',
          ),
        );
        const key = [...secrets.keys()].find(
          (k) => k.startsWith('credential.') && !before.has(k),
        );
        assert.ok(key);
        assert.equal(
          JSON.parse(secrets.get(key)).method,
          'keyboard-interactive',
        );
        assert.equal((await run(bridge, server.request)).code, 0);
        assert.equal(inputCount, prompts + 1);
        const replacement = 'replacement-interactive-' + randomUUID();
        inputAnswer = replacement;
        server.child.stdin.write(
          JSON.stringify({ password: replacement }) + '\n',
        );
        await sleep(100);
        assert.equal((await run(bridge, server.request)).code, 0);
        assert.equal(inputCount, prompts + 2);
        if (process.platform === 'darwin') {
          assert.equal(
            secrets.has(key),
            false,
            'a keyboard continuation stays manual',
          );
          assert.equal((await run(bridge, server.request)).code, 0);
          assert.equal(inputCount, prompts + 3);
        }
        assert.equal(JSON.parse(secrets.get(key)).password, replacement);
        assert.ok(!messages.join('\n').includes(replacement));
      } finally {
        inputAnswer = password;
        server.child.stdin.end();
        for (const key of [...secrets.keys()])
          if (!before.has(key)) secrets.delete(key);
      }
    },
  );
  await check('Use Once never saves an interactive password', async () => {
    const before = new Set(secrets.keys()),
      prompts = inputCount;
    const server = await interactiveServer();
    rememberChoice = false;
    try {
      assert.equal((await run(bridge, server.request)).code, 0);
      assert.equal((await run(bridge, server.request)).code, 0);
      assert.equal(inputCount, prompts + 2);
      assert.deepEqual(new Set(secrets.keys()), before);
    } finally {
      rememberChoice = true;
      server.child.stdin.end();
    }
  });
  await check(
    'verification codes and multi-step challenges do not persist credentials',
    async () => {
      for (const config of [
        { prompt: 'Verification code: ' },
        { prompts: ['Password: ', 'Verification code: '], code: password },
        { secondPrompt: 'Verification code: ', code: password },
        { partial: true, secondPrompt: 'Verification code: ', code: password },
      ]) {
        const before = new Set(secrets.keys());
        const server = await interactiveServer(config);
        try {
          const response = await run(bridge, server.request);
          assert.equal(response.code, 0, response.stderr);
          assert.deepEqual(new Set(secrets.keys()), before);
          assert.equal(
            ui.inputs.at(-1).prompt,
            translate(
              'This verification request cannot be remembered. Enter a response for this connection.',
            ),
          );
        } finally {
          server.child.stdin.end();
        }
      }
    },
  );
  await check(
    'localized forget confirms and deletes without exposing the password',
    async () => {
      selectCredential = true;
      acceptDelete = false;
      await commands.get('sshPasswordMemory.forget')();
      assert.equal(
        [...secrets.keys()].filter((k) => k.startsWith('credential.')).length,
        1,
      );
      const removal = ui.warnings.at(-1);
      assert.equal(
        removal.text,
        locale === 'zh-cn'
          ? '删除已保存的密码？'
          : 'Delete this saved password?',
      );
      assert.ok(
        removal.options.detail.includes(
          locale === 'zh-cn'
            ? '不会修改服务器上的密码'
            : 'Your server password will stay the same.',
        ),
      );
      acceptDelete = true;
      await commands.get('sshPasswordMemory.forget')();
      selectCredential = false;
      assert.equal(
        [...secrets.keys()].filter((k) => k.startsWith('credential.')).length,
        0,
      );
      assert.equal(
        messages.at(-1),
        locale === 'zh-cn'
          ? '已删除本机保存的密码。'
          : 'Saved password deleted.',
      );
      await commands.get('sshPasswordMemory.manage')();
      assert.equal(
        messages.at(-1),
        locale === 'zh-cn'
          ? '还没有保存的密码。连接时可选择“记住到本机”。'
          : 'No saved passwords yet. Choose Remember on This Device when you connect.',
      );
    },
  );
  await check('disable restores only settings it still owns', async () => {
    await commands.get('sshPasswordMemory.disable')();
    assert.deepEqual(settings, original);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(path.dirname(bridge), 'bridge.json'),
          'utf8',
        ),
      ).enabled,
      false,
    );
  });
  await check('user changes survive later disable', async () => {
    await commands.get('sshPasswordMemory.enable')();
    settings.set('path', 'user-changed-ssh');
    settings.set('useLocalServer', false);
    await commands.get('sshPasswordMemory.disable')();
    assert.equal(settings.get('path'), 'user-changed-ssh');
    assert.equal(settings.get('useLocalServer'), false);
    settings.set('path', original.get('path'));
  });
  await check(
    'deactivation is idempotent and leaves a working passthrough bridge',
    async () => {
      await commands.get('sshPasswordMemory.enable')();
      exports.deactivate();
      exports.deactivate();
      await sleep(1200);
      const a = await run(bridge, ['-V']),
        b = await run(original.get('path'), ['-V']);
      assert.equal(a.code, b.code);
      assert.equal(a.stderr, b.stderr);
    },
  );
  await check(
    'native SSH path errors follow the display language without exposing raw failures',
    async () => {
      const directory = path.join(tmp, 'native-message');
      await fs.mkdir(directory);
      const executable = path.join(directory, 'ssh' + suffix);
      await fs.copyFile(path.join(root, 'bin', 'ssh' + suffix), executable);
      await fs.writeFile(
        path.join(directory, 'bridge.json'),
        JSON.stringify({ realSSH: 'relative-ssh.exe', enabled: false }),
      );
      const response = await run(executable, ['-V'], {
        VSCODE_NLS_CONFIG: JSON.stringify({ resolvedLanguage: locale }),
      });
      assert.equal(response.code, 255);
      assert.ok(
        response.stderr.startsWith(
          locale === 'zh-cn'
            ? 'SSH 密码记忆：SSH 程序路径无效。'
            : 'SSH Password Memory: The SSH program path is invalid.',
        ),
      );
      assert.ok(response.stderr.includes('remote.SSH.path'));
      assert.ok(!response.stderr.includes(password));
    },
  );
} catch (error) {
  results.push({
    name: 'extension API integration',
    passed: false,
    error: String(error.message),
  });
  throw error;
} finally {
  exports.deactivate();
  for (const d of subscriptions) d.dispose();
  for (const p of children) {
    p.stdin?.end();
    p.kill();
  }
  await fs.writeFile(
    path.join(root, 'artifacts', 'extension-results-' + locale + '.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        usesMockedVSCodeAPI: true,
        locale,
        results,
      },
      null,
      2,
    ),
  );
}
