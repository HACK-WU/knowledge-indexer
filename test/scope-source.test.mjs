// S-01 单元测试：getSource / setSource
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getSource, setSource } from '../scripts/lib/scope.ts';
import { ensureScopeDir } from '../scripts/lib/store.ts';
import { getGroupIndexPath, getKbDir } from '../scripts/lib/scope.ts';

// 使用临时 scope 名避免污染真实 mcp-test
const TEST_SCOPE = 's01-test-' + Date.now();

function cleanup() {
  const dir = getKbDir(TEST_SCOPE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test('S-01: 新 scope 初始化后 source 为 null', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  const src = getSource(TEST_SCOPE);
  assert.equal(src, null, '未写入 source 时应返回 null');
  cleanup();
});

test('S-01: setSource 写入后 getSource 应能读出', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  setSource(TEST_SCOPE, { dir: '/tmp/abc', rootName: 'wiki', commit: 'deadbeef' });
  const src = getSource(TEST_SCOPE);
  assert.deepEqual(src, { dir: '/tmp/abc', rootName: 'wiki', commit: 'deadbeef' });
  cleanup();
});

test('S-01: setSource 覆盖更新 commit', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  setSource(TEST_SCOPE, { dir: '/tmp/abc', rootName: 'wiki', commit: 'old123' });
  setSource(TEST_SCOPE, { dir: '/tmp/abc', rootName: 'wiki', commit: 'new456' });
  const src = getSource(TEST_SCOPE);
  assert.equal(src.commit, 'new456');
  cleanup();
});

test('S-01: 存量 group-index.json（无 source 字段）兼容读取', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  // 模拟旧文件：不含 source 字段
  const filePath = getGroupIndexPath(TEST_SCOPE);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  delete data.source;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  const src = getSource(TEST_SCOPE);
  assert.equal(src, null, '存量文件应返回 null');
  cleanup();
});

test('S-01: setSource 字段不全应抛错', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  assert.throws(() => setSource(TEST_SCOPE, { dir: '', rootName: 'wiki', commit: 'a' }));
  cleanup();
});

test('S-01: roots 不应被 setSource 破坏', () => {
  cleanup();
  ensureScopeDir(TEST_SCOPE);
  // 写入一个有 roots 的 group-index
  const filePath = getGroupIndexPath(TEST_SCOPE);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  data.roots = { wiki: { 部署运维: {} } };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  setSource(TEST_SCOPE, { dir: '/tmp/abc', rootName: 'wiki', commit: 'c1' });
  const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.deepEqual(after.roots, { wiki: { 部署运维: {} } }, 'roots 必须保留');
  assert.equal(after.source.commit, 'c1');
  cleanup();
});
