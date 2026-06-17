// S-04 单元测试：handleImport（用 mock-mem 隔离 mem store）
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
import { ensureScopeDir, readJson, initScope } from '../scripts/lib/store.ts';
import { getKbDir, getGroupIndexPath, getRelationsCachePath, getSource } from '../scripts/lib/scope.ts';
import { registerTestScope, cleanupTestConfig } from './test-config.ts';
import { resetMemScopesCache } from '../scripts/lib/mem-client.ts';

// 准备测试 fixture：一个真实的临时 git 仓库 + 几个 .md 文件
function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's04-kb-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Root README\n这是根文件');
  fs.mkdirSync(path.join(dir, '部署运维'));
  fs.writeFileSync(path.join(dir, '部署运维', '备份恢复.md'), '# 备份恢复\n备份恢复 SOP');
  fs.writeFileSync(path.join(dir, '部署运维', '监控告警.md'), '# 监控告警\n监控告警 SOP');
  fs.mkdirSync(path.join(dir, 'API文档'));
  fs.writeFileSync(path.join(dir, 'API文档', '认证.md'), '# 认证\n认证 API');

  // git init（关闭 gpg 签名 + 注入 user 配置，避免本机全局配置干扰）
  execSync('git init -q', { cwd: dir });
  const gitEnv = ' -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c tag.gpgsign=false ';
  execSync(`git${gitEnv}add . && git${gitEnv}commit -q -m init`, { cwd: dir, shell: '/bin/bash' });
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

const TEST_SCOPE = 's04-test-' + Date.now();
registerTestScope(TEST_SCOPE);
initScope(TEST_SCOPE);
process.env.MOCK_SCOPES = TEST_SCOPE;  // mock-mem scope list 返回测试 scope
resetMemScopesCache();  // 清除缓存，确保重新读取

function cleanup() {
  const dir = getKbDir(TEST_SCOPE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test('S-04: full 模式导入 3 个文件，全部成功', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  const resultsFile = makeAiResults(sourceDir, [
    { path: '部署运维/备份恢复.md', groupPath: 'wiki/部署运维', summary: 's1', keywords: ['备份', '恢复'] },
    { path: '部署运维/监控告警.md', groupPath: 'wiki/部署运维', summary: 's2', keywords: ['监控'] },
    { path: 'API文档/认证.md', groupPath: 'wiki/API文档', summary: 's3', keywords: ['认证', 'API'] },
  ]);

  const result = await handleImport({ scope: TEST_SCOPE, resultsFile });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'full');
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.vectorized, 3);
  assert.equal(result.stats.errors, 0);

  // groups 至少包含 rootName + 两个子目录
  assert.ok(result.groups.includes('wiki'));
  assert.ok(result.groups.includes('wiki/部署运维'));
  assert.ok(result.groups.includes('wiki/API文档'));

  // source 块写入
  assert.equal(result.source.rootName, 'wiki');
  assert.match(result.source.commit, /^[0-9a-f]{40}$/);
  const persisted = getSource(TEST_SCOPE);
  assert.deepEqual(persisted, result.source);

  // group-index groups 树结构
  const idx = readJson(getGroupIndexPath(TEST_SCOPE));
  assert.deepEqual(Object.keys(idx.groups.wiki).sort(), ['API文档', '部署运维']);

  // relations-cache 含 memoryId + sourcePath
  const cache = readJson(getRelationsCachePath(TEST_SCOPE));
  const grp = cache.groups['wiki/部署运维'];
  assert.ok(grp);
  const rel = grp.hot_relations.find((r) => r.text === '备份恢复');
  assert.ok(rel, '备份恢复 relation 应存在');
  assert.match(rel.memoryId, /^[0-9a-f]{16}$/);
  assert.equal(rel.sourcePath, '部署运维/备份恢复.md');
  assert.equal(rel.isImported, true);

  // local KB 写入
  const localKbPath = path.join(getKbDir(TEST_SCOPE), 'wiki/部署运维/index.json');
  const localKb = JSON.parse(fs.readFileSync(localKbPath, 'utf-8'));
  assert.match(localKb['备份恢复'], /备份恢复 SOP/);

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(resultsFile);
});

test('S-04: 部分向量化失败时，失败条目不写入索引', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  const resultsFile = makeAiResults(sourceDir, [
    { path: '部署运维/备份恢复.md', groupPath: 'wiki/部署运维', summary: 'good', keywords: ['a'] },
    { path: '部署运维/监控告警.md', groupPath: 'wiki/部署运维', summary: 'fail-me-now', keywords: ['b'] },
  ]);
  process.env.MOCK_FAIL_PATHS = 'fail-me-now';

  const result = await handleImport({ scope: TEST_SCOPE, resultsFile });

  delete process.env.MOCK_FAIL_PATHS;

  assert.equal(result.stats.total, 2);
  assert.equal(result.stats.vectorized, 1);
  assert.equal(result.stats.errors, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '部署运维/监控告警.md');

  // 仅成功条目写入 cache
  const cache = readJson(getRelationsCachePath(TEST_SCOPE));
  const rels = cache.groups['wiki/部署运维'].hot_relations.map((r) => r.text);
  assert.deepEqual(rels.sort(), ['备份恢复']);

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(resultsFile);
});

test('S-04: meta.sourceDir 不存在应抛错', async () => {
  cleanup();
  const resultsFile = makeAiResults('/tmp/__nonexistent_kb__', [
    { path: 'a.md', groupPath: 'wiki', summary: 's', keywords: [] },
  ]);
  await assert.rejects(() => handleImport({ scope: TEST_SCOPE, resultsFile }), /sourceDir 不存在/);
  cleanup();
  fs.unlinkSync(resultsFile);
});

test('S-04: 空 entries 也能成功（创建 root group + source）', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  const resultsFile = makeAiResults(sourceDir, []);

  const result = await handleImport({ scope: TEST_SCOPE, resultsFile });
  assert.equal(result.stats.total, 0);
  assert.equal(result.stats.vectorized, 0);
  assert.deepEqual(result.groups, ['wiki']);
  assert.match(result.source.commit, /^[0-9a-f]{40}$/);

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(resultsFile);
});

test('S-04: mapping 模式覆盖 groupPath 和 relation', async () => {
  cleanup();
  const sourceDir = makeFixtureRepo();
  const resultsFile = makeAiResults(sourceDir, [
    { path: '部署运维/备份恢复.md', groupPath: 'wiki/部署运维', summary: 's', keywords: [] },
  ]);
  const mappingFile = path.join(os.tmpdir(), `mapping-${Date.now()}.json`);
  fs.writeFileSync(mappingFile, JSON.stringify({
    root_name: 'wiki',
    groups: [{
      path: 'wiki/自定义分组',
      sources: [{ file: '部署运维/备份恢复.md', relation: '备份恢复-Custom' }],
    }],
  }));

  const result = await handleImport({ scope: TEST_SCOPE, resultsFile, mappingFile });
  assert.ok(result.groups.includes('wiki/自定义分组'));

  const cache = readJson(getRelationsCachePath(TEST_SCOPE));
  const customGrp = cache.groups['wiki/自定义分组'];
  assert.ok(customGrp);
  assert.ok(customGrp.hot_relations.find((r) => r.text === '备份恢复-Custom'));

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(resultsFile);
  fs.unlinkSync(mappingFile);
});
