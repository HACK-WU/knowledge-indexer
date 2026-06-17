// S-06 单元测试：handleIncremental（用 mock-mem 隔离）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK_MEM = path.join(__dirname, 'fixtures', 'mock-mem.mjs');

// 创建临时目录，将 mock-mem.mjs 复制为 mem 命令
const MOCK_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-mem-bin-'));
fs.copyFileSync(MOCK_MEM, path.join(MOCK_BIN_DIR, 'mem'));
fs.chmodSync(path.join(MOCK_BIN_DIR, 'mem'), 0o755);

// 保存原始 PATH 并在测试前添加 mock 目录
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${MOCK_BIN_DIR}:${ORIGINAL_PATH}`;

import { handleImport } from '../scripts/lib/import.ts';
import { handleIncremental, classifyEntries, removeFromCache } from '../scripts/lib/incremental.ts';
import { ensureScopeDir, readJson } from '../scripts/lib/store.ts';
import { getKbDir, getGroupIndexPath, getRelationsCachePath, getSource } from '../scripts/lib/scope.ts';
import { registerTestScope, cleanupTestConfig } from './test-config.ts';
import { resetMemScopesCache } from '../scripts/lib/mem-client.ts';

const GIT_ENV = ' -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c tag.gpgsign=false ';

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's06-kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '# A v1');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# B v1');
  execSync('git init -q', { cwd: dir });
  execSync(`git${GIT_ENV}add . && git${GIT_ENV}commit -q -m init`, { cwd: dir, shell: '/bin/bash' });
  return dir;
}

function makeAiResults(sourceDir, entries) {
  const file = path.join(os.tmpdir(), `ai-results-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    meta: { sourceDir, rootName: 'wiki' },
    entries,
  }, null, 2));
  return file;
}

const TEST_SCOPE = 's06-test-' + Date.now();
registerTestScope(TEST_SCOPE);
process.env.MOCK_SCOPES = TEST_SCOPE;
resetMemScopesCache();

function cleanup() {
  const dir = getKbDir(TEST_SCOPE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test('S-06: classifyEntries 按 action 分组', () => {
  const result = classifyEntries([
    { path: 'a', action: 'add' },
    { path: 'b', action: 'modify' },
    { path: 'c', action: 'delete' },
    { path: 'd' }, // 缺失 action 默认 add（实际由 normalizeAiResults 填充，这里直接给出）
  ]);
  assert.equal(result.add.length, 2);  // a + d
  assert.equal(result.modify.length, 1);
  assert.equal(result.delete.length, 1);
});

test('S-06: 未首次导入时增量应抛错', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  const resultsFile = makeAiResults(sourceDir, [
    { path: 'a.md', groupPath: 'wiki', summary: 's', keywords: [], action: 'add' },
  ]);
  ensureScopeDir(TEST_SCOPE);
  await assert.rejects(
    () => handleIncremental({ scope: TEST_SCOPE, resultsFile }),
    /尚未首次导入/
  );
  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(resultsFile);
});

test('S-06: full 导入后 增量 add + modify + delete 全流程', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();

  // 1) 首次导入
  const fullResults = makeAiResults(sourceDir, [
    { path: 'a.md', groupPath: 'wiki', summary: 'A v1', keywords: ['a'] },
    { path: 'sub/b.md', groupPath: 'wiki/sub', summary: 'B v1', keywords: ['b'] },
  ]);
  const fullResult = await handleImport({ scope: TEST_SCOPE, resultsFile: fullResults });
  assert.equal(fullResult.stats.vectorized, 2);
  const aMemId = fullResult.errors.length === 0
    ? readJson(getRelationsCachePath(TEST_SCOPE)).groups['wiki'].hot_relations.find((r) => r.sourcePath === 'a.md').memoryId
    : null;
  const bMemId = readJson(getRelationsCachePath(TEST_SCOPE)).groups['wiki/sub'].hot_relations.find((r) => r.sourcePath === 'sub/b.md').memoryId;
  assert.ok(aMemId);
  assert.ok(bMemId);
  const baseCommit = getSource(TEST_SCOPE).commit;
  fs.unlinkSync(fullResults);

  // 2) 修改文件 + 增加新文件 + 提交一次
  fs.writeFileSync(path.join(sourceDir, 'a.md'), '# A v2 改了');
  fs.writeFileSync(path.join(sourceDir, 'c.md'), '# 新文件');
  // sub/b.md 准备删除
  fs.unlinkSync(path.join(sourceDir, 'sub', 'b.md'));
  execSync(`git${GIT_ENV}add -A && git${GIT_ENV}commit -q -m v2`, { cwd: sourceDir, shell: '/bin/bash' });

  // 3) 构造增量 ai-results
  const incResults = makeAiResults(sourceDir, [
    { path: 'a.md', groupPath: 'wiki', summary: 'A v2', keywords: ['a', '更新'], memoryId: aMemId, action: 'modify' },
    { path: 'c.md', groupPath: 'wiki', summary: 'C', keywords: ['c'], action: 'add' },
    { path: 'sub/b.md', groupPath: 'wiki/sub', summary: '', keywords: [], memoryId: bMemId, action: 'delete' },
  ]);

  const incResult = await handleIncremental({ scope: TEST_SCOPE, resultsFile: incResults });

  // 4) 校验统计
  assert.equal(incResult.mode, 'incremental');
  assert.equal(incResult.stats.added, 1);
  assert.equal(incResult.stats.modified, 1);
  assert.equal(incResult.stats.deleted, 1);
  assert.equal(incResult.stats.errors, 0, JSON.stringify(incResult.errors));
  assert.equal(incResult.previousCommit, baseCommit);
  assert.notEqual(incResult.newCommit, baseCommit);
  assert.equal(getSource(TEST_SCOPE).commit, incResult.newCommit);

  // 5) 校验 cache 状态
  const cache = readJson(getRelationsCachePath(TEST_SCOPE));
  // a.md 仍在（memoryId 是 path hash，modify 前后不变，不影响功能）
  const aRel = cache.groups['wiki'].hot_relations.find((r) => r.sourcePath === 'a.md');
  assert.ok(aRel);
  // c.md 新增
  const cRel = cache.groups['wiki'].hot_relations.find((r) => r.sourcePath === 'c.md');
  assert.ok(cRel);
  // sub/b.md 已删
  const bRel = cache.groups['wiki/sub'].hot_relations.find((r) => r.sourcePath === 'sub/b.md');
  assert.equal(bRel, undefined, 'delete 应从 cache 移除');

  // 6) local KB
  const subKbPath = path.join(getKbDir(TEST_SCOPE), 'wiki/sub/index.json');
  if (fs.existsSync(subKbPath)) {
    const subKb = JSON.parse(fs.readFileSync(subKbPath, 'utf-8'));
    assert.ok(!('b' in subKb), 'local KB 应已移除 b');
  }

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(incResults);
});

test('S-06: removeFromCache 找不到目标返回 false', () => {
  const cache = {
    version: 1, scope: 't', partition_config: { maxHotCount: 10, maxKeywordCount: 50 },
    groups: { 'wiki': { hot_relations: [], keywords: [], max_hot_count: 10 } },
    updatedAt: null,
  };
  assert.equal(removeFromCache(cache, 'nonexistent.md'), false);
});

test('S-06: rootName 不一致应抛错', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  // 先 full 导入（rootName=wiki）
  const f1 = makeAiResults(sourceDir, [{ path: 'a.md', groupPath: 'wiki', summary: 's', keywords: [] }]);
  await handleImport({ scope: TEST_SCOPE, resultsFile: f1 });
  fs.unlinkSync(f1);

  // 增量用 rootName=docs（不一致）
  const f2 = path.join(os.tmpdir(), `ai-${Date.now()}.json`);
  fs.writeFileSync(f2, JSON.stringify({
    meta: { sourceDir, rootName: 'docs' },
    entries: [{ path: 'a.md', groupPath: 'docs', summary: 's', keywords: [], action: 'add' }],
  }));
  await assert.rejects(() => handleIncremental({ scope: TEST_SCOPE, resultsFile: f2 }), /rootName.*不一致/);

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(f2);
});
