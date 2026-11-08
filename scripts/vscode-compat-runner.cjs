'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

exports.run = async function run() {
  assert.match(vscode.version, /^1\.73\.0(?:-|$)/);
  assert.equal(typeof vscode.l10n?.t, 'function');

  const extension = vscode.extensions.getExtension(
    'Devlin.remote-ssh-password-memory',
  );
  assert.ok(extension, 'password-memory extension is installed');
  await extension.activate();

  const deadline = Date.now() + 30000;
  while (!extension.isActive && Date.now() < deadline) await sleep(100);
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'enable',
    'disable',
    'manage',
    'forget',
    'diagnostics',
  ])
    assert.ok(commands.includes('sshPasswordMemory.' + command), command);

  console.log(
    `VS Code ${vscode.version}: activation, l10n, and five commands passed`,
  );
};
