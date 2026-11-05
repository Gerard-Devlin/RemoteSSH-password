import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const json = async (file) =>
  JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const manifest = await json('package.json');
const english = await json('package.nls.json');
const chinese = await json('package.nls.zh-cn.json');
const bundle = await json('l10n/bundle.l10n.zh-cn.json');
const source = await fs.readFile(path.join(root, 'src/extension.ts'), 'utf8');
const ast = ts.createSourceFile(
  'extension.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const calls = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'vscode.l10n.t'
  )
    calls.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
const placeholders = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

test('manifest declares the native VS Code localization directory', () => {
  assert.equal(manifest.l10n, './l10n');
  assert.deepEqual(manifest.extensionKind, ['ui']);
});

test('all manifest localization tokens have English and Chinese entries', () => {
  const tokens = new Set(
    [...JSON.stringify(manifest).matchAll(/%([^%]+)%/g)].map((m) => m[1]),
  );
  assert.deepEqual([...tokens].sort(), Object.keys(english).sort());
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const key of tokens) {
    assert.ok(english[key].trim());
    assert.ok(chinese[key].trim());
    assert.ok(!/[\u3400-\u9fff]/u.test(english[key]));
    assert.deepEqual(placeholders(english[key]), placeholders(chinese[key]));
  }
});

test('stable command IDs are independent of translated titles', () => {
  assert.deepEqual(
    manifest.contributes.commands.map((c) => c.command),
    ['enable', 'disable', 'manage', 'forget', 'diagnostics'].map(
      (c) => 'sshPasswordMemory.' + c,
    ),
  );
  for (const command of manifest.contributes.commands) {
    assert.equal(command.category, '%command.category%');
    assert.ok(/^%command\.[a-z]+%$/.test(command.title));
  }
});

test('every runtime translation uses an English literal and has a Chinese translation', () => {
  assert.ok(calls.length >= 40);
  const used = new Set();
  for (const call of calls) {
    assert.ok(
      ts.isStringLiteral(call.arguments[0]),
      'Translation keys must be static English strings',
    );
    const key = call.arguments[0].text;
    assert.ok(!/[\u3400-\u9fff]/u.test(key));
    assert.equal(typeof bundle[key], 'string', 'Missing translation: ' + key);
    assert.ok(bundle[key].trim());
    used.add(key);
  }
  assert.deepEqual(
    [...used].sort(),
    Object.keys(bundle).sort(),
    'Remove stale translations',
  );
});

test('runtime translations preserve every interpolation placeholder', () => {
  for (const call of calls) {
    const key = call.arguments[0].text;
    assert.deepEqual(placeholders(bundle[key]), placeholders(key), key);
    for (const p of placeholders(key))
      assert.ok(Number(p.slice(1, -1)) < call.arguments.length - 1, key);
  }
});

test('production UI source has no hardcoded Chinese text or translated control-flow comparisons', () => {
  assert.ok(!/[\u3400-\u9fff]/u.test(source));
  assert.ok(!source.includes("startsWith('如何使用')"));
  // Persistence behavior is driven by a boolean field, not the selected label.
  assert.ok(source.includes('remember: choice.remember'));
});

test('raw SSH prompt and fingerprint context are not translated', () => {
  const manual = calls.find(
    (c) => c.arguments[0].text === 'Manual authentication (not saved): {0}',
  );
  assert.equal(manual.arguments[1].getText(ast), 'prompt.slice(0, 500)');
  assert.ok(source.includes('prompt.slice(0, 8192)'));
  assert.ok(source.includes("? { value: 'yes' }"));
});
