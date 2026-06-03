// S-05 单元测试：parseGitDiff + handleDiff first_import 分支
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseGitDiff, handleDiff } from '../scripts/lib/diff.ts';
import { ensureScopeDir } from '../scripts/lib/store.ts';
import { getKbDir } from '../scripts/lib/scope.ts';

test('S-05: parseGitDiff 解析 A/M/D', () => {
  const stdout = 'A\tfoo.md\nM\tbar.md\nD\tbaz.md';
  const result = parseGitDiff(stdout);
  assert.deepEqual(result, [
    { status: 'A', path: 'foo.md' },
    { status: 'M', path: 'bar.md' },
    { status: 'D', path: 'baz.md' },
  ]);
});

test('S-05: parseGitDiff 重命名 R 拆解为 D+A', () => {
  const stdout = 'R100\told/path.md\tnew/path.md';
  const result = parseGitDiff(stdout);
  assert.deepEqual(result, [
    { status: 'D', path: 'old/path.md' },
    { status: 'A', path: 'new/path.md' },
  ]);
});

test('S-05: parseGitDiff 复制 C 只产生 A', () => {
  const stdout = 'C75\tsrc.md\tdst.md';
  const result = parseGitDiff(stdout);
  assert.deepEqual(result, [{ status: 'A', path: 'dst.md' }]);
});

test('S-05: parseGitDiff 忽略 unmerged U', () => {
  const stdout = 'U\tconflict.md\nA\tnew.md';
  const result = parseGitDiff(stdout);
  assert.deepEqual(result, [{ status: 'A', path: 'new.md' }]);
});

test('S-05: parseGitDiff T/MM 归 M', () => {
  const stdout = 'T\ta.md\nMM\tb.md';
  const result = parseGitDiff(stdout);
  assert.deepEqual(result, [
    { status: 'M', path: 'a.md' },
    { status: 'M', path: 'b.md' },
  ]);
});

test('S-05: parseGitDiff 空输入', () => {
  assert.deepEqual(parseGitDiff(''), []);
  assert.deepEqual(parseGitDiff('\n\n'), []);
});

test('S-05: handleDiff 无 source 返回 first_import', () => {
  const TEST_SCOPE = 's05-test-' + Date.now();
  const dir = getKbDir(TEST_SCOPE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  ensureScopeDir(TEST_SCOPE);

  const out = handleDiff({ scope: TEST_SCOPE });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'diff');
  assert.equal(out.status, 'first_import');
  assert.match(out.hint, /scan-kb import/);

  fs.rmSync(dir, { recursive: true, force: true });
});
