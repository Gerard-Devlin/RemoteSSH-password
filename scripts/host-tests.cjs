const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { CredentialCore, keyFor } = require('../dist/core.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.run = async (testContext) => {
  const results = [];
  const check = async (name, fn) => {
    await fn();
    results.push({ name, passed: true });
  };
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    const extension = vscode.extensions.getExtension(
      manifest.publisher + '.' + manifest.name,
    );
    assert.ok(extension, 'extension discovered');
    await check(
      'startup activation is local and completes without a connection',
      async () => {
        const deadline = Date.now() + 20000;
        while (!extension.isActive && Date.now() < deadline) await sleep(200);
        assert.equal(extension.isActive, true);
        assert.equal(extension.extensionKind, vscode.ExtensionKind.UI);
        assert.equal(vscode.env.remoteName, undefined);
      },
    );
    await check('five management commands registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const n of ['enable', 'disable', 'manage', 'forget', 'diagnostics'])
        assert.ok(commands.includes('sshPasswordMemory.' + n));
    });
    await check(
      'automatic setup is ready, or explicit disable remains off',
      async () => {
        const cfg = vscode.workspace.getConfiguration('remote.SSH');
        if (process.env.SSHPM_TEST_PHASE === 'disabled') {
          assert.equal(cfg.inspect('path').globalValue, undefined);
          assert.equal(cfg.inspect('useLocalServer').globalValue, undefined);
        } else {
          assert.ok(cfg.inspect('path').globalValue.includes('bridge-v2'));
          assert.equal(cfg.inspect('useLocalServer').globalValue, true);
          assert.ok(process.env.SSHPM_WINDOW_PIPE);
        }
      },
    );
    if (process.env.SSHPM_TEST_PHASE === 'disabled') return;
    const { secrets, state, storage } =
      testContext ?? (await extension.activate());
    await check(
      'same extension storage survives version and installation path changes',
      async () => {
        if (process.env.SSHPM_TEST_PHASE === 'seed') {
          await state.update('testStorage', storage);
          await state.update(
            'testBridge',
            vscode.workspace.getConfiguration('remote.SSH').inspect('path')
              .globalValue,
          );
          await state.update('testVersion', extension.packageJSON.version);
          await state.update('testPath', extension.extensionPath);
        } else {
          assert.equal(storage, state.get('testStorage'));
          assert.notEqual(
            vscode.workspace.getConfiguration('remote.SSH').inspect('path')
              .globalValue,
            state.get('testBridge'),
          );
          await fs.access(state.get('testBridge'));
          assert.notEqual(
            extension.packageJSON.version,
            state.get('testVersion'),
          );
          assert.notEqual(extension.extensionPath, state.get('testPath'));
        }
      },
    );
    const target = { host: 'fixture.invalid', port: '2222', user: 'fixture' };
    const fingerprint = 'SHA256:' + 'X'.repeat(43);
    let value = 'host-fixture-' + crypto.randomUUID() + '-中文!"&';
    const core = new CredentialCore(
      secrets,
      {
        ask: async () => ({ value, remember: true }),
        trust: async () => ({ canceled: true }),
        changed: () => {},
        cancel: () => {},
      },
      async () => {},
    );
    if (process.env.SSHPM_TEST_PHASE === 'seed') {
      await check(
        'real SecretStorage contains no candidate before authentication',
        async () => {
          await secrets.delete(keyFor(target));
          await core.handle({ type: 'open', session: 's', target });
          await core.handle({
            type: 'ask',
            session: 's',
            kind: 'interactive-password',
            verified: true,
            fingerprint,
          });
          assert.equal(await secrets.get(keyFor(target)), undefined);
        },
      );
      await check(
        'authenticated success commits to real SecretStorage',
        async () => {
          await core.handle({
            type: 'success',
            session: 's',
            method: 'keyboard-interactive',
          });
          assert.equal(
            JSON.parse(await secrets.get(keyFor(target))).password,
            value,
          );
          await state.update(
            'testDigest',
            crypto.createHash('sha256').update(value).digest('hex'),
          );
        },
      );
    } else {
      await check(
        'new VS Code process reuses encrypted credential without prompt',
        async () => {
          await core.handle({ type: 'open', session: 's', target });
          const answer = await core.handle({
            type: 'ask',
            session: 's',
            kind: 'interactive-password',
            verified: true,
            fingerprint,
          });
          assert.equal(answer.source, 'saved');
          assert.equal(
            crypto.createHash('sha256').update(answer.value).digest('hex'),
            state.get('testDigest'),
          );
        },
      );
      await check('forget removes real SecretStorage key', async () => {
        await core.forget(target);
        assert.equal(await secrets.get(keyFor(target)), undefined);
        await state.update('testDigest', undefined);
      });
      await check(
        'explicit disable restores the original isolated settings',
        async () => {
          await vscode.commands.executeCommand('sshPasswordMemory.disable');
          assert.equal(
            vscode.workspace.getConfiguration('remote.SSH').inspect('path')
              .globalValue,
            undefined,
          );
        },
      );
    }
  } catch (error) {
    results.push({
      name: 'test-runner',
      passed: false,
      error: String(error.message),
    });
    throw error;
  } finally {
    await fs.writeFile(
      path.join(
        __dirname,
        '..',
        'artifacts',
        'host-' + process.env.SSHPM_TEST_PHASE + '.json',
      ),
      JSON.stringify(
        {
          vscode: vscode.version,
          phase: process.env.SSHPM_TEST_PHASE,
          results,
        },
        null,
        2,
      ),
    );
  }
};
