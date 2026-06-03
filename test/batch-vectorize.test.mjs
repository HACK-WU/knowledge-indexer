// S-03 单元测试：batchVectorize / parseMemoryId / vectorizeOne / deleteMemory
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

import {
  parseMemoryId,
  buildVectorizeContent,
  batchVectorize,
  vectorizeOne,
  deleteMemory,
} from '../scripts/lib/batch-vectorize.ts';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK_MEM = path.join(__dirname, 'fixtures', 'mock-mem.mjs');

// 创建临时目录，将 mock-mem.mjs 复制为 mem 命令
const MOCK_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-mem-bin-'));
fs.copyFileSync(MOCK_MEM, path.join(MOCK_BIN_DIR, 'mem'));
fs.chmodSync(path.join(MOCK_BIN_DIR, 'mem'), 0o755);

// 保存原始 PATH 并在测试前添加 mock 目录
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${MOCK_BIN_DIR}:${ORIGINAL_PATH}`;

// 设置较短的超时时间，避免测试执行太久
process.env.MEM_TIMEOUT_MS = '5000';

test('S-03: parseMemoryId 提取标准格式', () => {
  const stdout = `Stored: "..." in scope 'mcp-test'\nMemory ID: 0123abcd\n`;
  assert.equal(parseMemoryId(stdout), '0123abcd');
});

test('S-03: parseMemoryId 缺失返回 null', () => {
  assert.equal(parseMemoryId('Stored: "..." in scope x'), null);
});

test('S-03: parseMemoryId 容忍前后空格', () => {
  assert.equal(parseMemoryId('  Memory ID:   abc-def-123  \n'), 'abc-def-123');
});

test('S-03: buildVectorizeContent 格式', () => {
  const text = buildVectorizeContent({
    path: 'a/b.md',
    groupPath: 'wiki/a',
    summary: 'hello',
    keywords: ['k1', 'k2'],
    enriched: true,
    memoryId: null,
    action: 'add',
  });
  assert.match(text, /\[摘要\] hello/);
  assert.match(text, /\[关键词\] k1, k2/);
  assert.match(text, /\[路径\] a\/b\.md/);
});

test('S-03: vectorizeOne 成功路径', () => {
  const r = vectorizeOne(
    { path: 'a.md', groupPath: 'wiki', summary: 's', keywords: [], enriched: false, memoryId: null, action: 'add' },
    'mock'
  );
  assert.equal(r.ok, true);
  assert.match(r.memoryId, /^[0-9a-f]{16}$/);
});

test('S-03: vectorizeOne 子进程失败应记录 error', () => {
  process.env.MOCK_FAIL_PATHS = 'fail-me';
  const r = vectorizeOne(
    { path: 'fail-me.md', groupPath: 'wiki', summary: 'fail-me', keywords: [], enriched: false, memoryId: null, action: 'add' },
    'mock'
  );
  delete process.env.MOCK_FAIL_PATHS;
  assert.equal(r.ok, false);
  assert.match(r.error, /mem store 失败/);
});

test('S-03: vectorizeOne 无 Memory ID 行应返回 error', () => {
  process.env.MOCK_NO_ID = '1';
  const r = vectorizeOne(
    { path: 'a.md', groupPath: 'wiki', summary: 's', keywords: [], enriched: false, memoryId: null, action: 'add' },
    'mock'
  );
  delete process.env.MOCK_NO_ID;
  assert.equal(r.ok, false);
  assert.match(r.error, /Memory ID/);
});

test('S-03: batchVectorize 部分失败', () => {
  process.env.MOCK_FAIL_PATHS = 'bad';
  const entries = [
    { path: 'ok1.md', groupPath: 'wiki', summary: 'ok1', keywords: [], enriched: false, memoryId: null, action: 'add' },
    { path: 'bad.md', groupPath: 'wiki', summary: 'bad', keywords: [], enriched: false, memoryId: null, action: 'add' },
    { path: 'ok2.md', groupPath: 'wiki', summary: 'ok2', keywords: [], enriched: false, memoryId: null, action: 'add' },
  ];
  const r = batchVectorize(entries, 'mock');
  delete process.env.MOCK_FAIL_PATHS;

  assert.equal(r.ok.size, 2);
  assert.ok(r.ok.has('ok1.md'));
  assert.ok(r.ok.has('ok2.md'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, 'bad.md');
});

test('S-03: batchVectorize 跳过 action=delete 条目', () => {
  const entries = [
    { path: 'a.md', groupPath: 'wiki', summary: 'a', keywords: [], enriched: false, memoryId: 'x', action: 'delete' },
    { path: 'b.md', groupPath: 'wiki', summary: 'b', keywords: [], enriched: false, memoryId: null, action: 'add' },
  ];
  const r = batchVectorize(entries, 'mock');
  assert.equal(r.ok.size, 1);
  assert.ok(r.ok.has('b.md'));
  assert.ok(!r.ok.has('a.md'));
});

test('S-03: batchVectorize 空数组', () => {
  const r = batchVectorize([], 'mock');
  assert.equal(r.ok.size, 0);
  assert.equal(r.errors.length, 0);
});

test('S-03: deleteMemory 成功', () => {
  const r = deleteMemory('abc-123');
  assert.equal(r.ok, true);
});

test('S-03: deleteMemory 失败返回 ok=false', () => {
  process.env.MOCK_DELETE_FAIL = '1';
  const r = deleteMemory('abc-123');
  delete process.env.MOCK_DELETE_FAIL;
  assert.equal(r.ok, false);
  assert.match(r.error, /mem delete/);
});
