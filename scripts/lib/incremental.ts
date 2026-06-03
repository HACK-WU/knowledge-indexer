/**
 * incremental.ts —— S-06：增量导入
 *
 * 三类操作：
 *   - action='add'    → 新增：batchVectorize → 写 relations-cache + local KB
 *   - action='modify' → 更新：mem delete oldId → batchVectorize → 写新 memoryId
 *   - action='delete' → 删除：mem delete oldId → 移除 cache + local KB
 *
 * Group 树只增不删；source.commit 全部成功后才更新到 HEAD。
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  getSource,
  setSource,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir } from './store.js';
import { normalizeAiResults, type ScanResultEntry, type AiResultsFile } from './ai-results.js';
import {
  vectorizeOne,
  deleteMemory,
  type BatchVectorizeOptions,
} from './batch-vectorize.js';
import type {
  GroupIndex,
  RelationsCache,
  ImportResult,
  HandleImportArgs,
} from './import.js';

// ─── 类型 ───

export interface IncrementalStats {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  errors: number;
}

export interface IncrementalResult extends Omit<ImportResult, 'mode' | 'stats'> {
  mode: 'incremental';
  stats: IncrementalStats;
  previousCommit: string;
  newCommit: string;
}

interface ClassifiedEntries {
  add: ScanResultEntry[];
  modify: ScanResultEntry[];
  delete: ScanResultEntry[];
}

// ─── 工具 ───

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function deriveRelationText(filePath: string): string {
  const base = stripMarkdownExtension(path.posix.basename(filePath));
  return base.replace(/[*~`]/g, '').trim() || base;
}

function buildVectorizeContent(entry: ScanResultEntry): string {
  const kw = (entry.keywords || []).join(', ');
  return `[摘要] ${entry.summary}\n[关键词] ${kw}\n[路径] ${entry.path}`;
}

function getGitHead(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ─── 分类 ───

export function classifyEntries(entries: ScanResultEntry[]): ClassifiedEntries {
  const out: ClassifiedEntries = { add: [], modify: [], delete: [] };
  for (const e of entries) {
    if (e.action === 'modify') out.modify.push(e);
    else if (e.action === 'delete') out.delete.push(e);
    else out.add.push(e);
  }
  return out;
}

// ─── Group 树 ───

function ensureGroupPathInTree(index: GroupIndex, groupPath: string): void {
  const segments = trimSlashes(groupPath).split('/').filter(Boolean);
  if (segments.length === 0) return;
  if (!index.roots[segments[0]]) index.roots[segments[0]] = {};
  let cur: Record<string, unknown> = index.roots[segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (typeof cur[seg] !== 'object' || cur[seg] === null) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
}

// ─── relations-cache 写/删 ───

function generateNextId(cache: RelationsCache): string {
  let max = 0;
  for (const data of Object.values(cache.groups)) {
    for (const r of data.hot_relations) {
      const m = r.id.match(/^rel_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  }
  return `rel_${String(max + 1).padStart(3, '0')}`;
}

function ensureCacheGroup(cache: RelationsCache, groupPath: string) {
  if (!cache.groups[groupPath]) {
    cache.groups[groupPath] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: cache.partition_config?.maxHotCount ?? 10,
    };
  }
  return cache.groups[groupPath];
}

function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  keywords: string[],
  memoryId: string,
  sourcePath: string
): void {
  const grp = ensureCacheGroup(cache, groupPath);
  let rel = grp.hot_relations.find((r) => r.text === relationText);
  if (!rel) {
    rel = {
      id: generateNextId(cache),
      text: relationText,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
    };
    grp.hot_relations.push(rel);
  } else {
    rel.isImported = true;
  }
  rel.memoryId = memoryId;
  rel.sourcePath = sourcePath;

  for (const kw of keywords || []) {
    const t = String(kw).trim();
    if (t && !grp.keywords.includes(t)) grp.keywords.push(t);
  }
  const maxKw = cache.partition_config?.maxKeywordCount ?? 50;
  if (grp.keywords.length > maxKw) {
    grp.keywords.splice(0, grp.keywords.length - maxKw);
  }
}

/**
 * 按 sourcePath 删除 relation。
 * 如果删除后该 group 为空，本期不清理 group 自身（保持 Group 树只增不删的契约）。
 * @returns 是否真的删掉了一条 relation
 */
export function removeFromCache(cache: RelationsCache, sourcePath: string): boolean {
  for (const groupData of Object.values(cache.groups)) {
    const idx = groupData.hot_relations.findIndex((r) => r.sourcePath === sourcePath);
    if (idx >= 0) {
      groupData.hot_relations.splice(idx, 1);
      return true;
    }
  }
  return false;
}

// ─── local KB ───

function loadLocalKb(localKbPath: string): Record<string, unknown> {
  if (!fs.existsSync(localKbPath)) return {};
  return readJson<Record<string, unknown>>(localKbPath) || {};
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

export function removeFromLocalKb(scope: string, groupPath: string, relationText: string): boolean {
  const localKbPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(localKbPath)) return false;
  const localKb = loadLocalKb(localKbPath);
  if (!(relationText in localKb)) return false;
  delete localKb[relationText];
  writeJson(localKbPath, localKb);
  return true;
}

// ─── 主入口 ───

export interface HandleIncrementalArgs extends HandleImportArgs {
  // memBinPath 已移除，直接使用全局 mem 命令
}

export function handleIncremental(args: HandleIncrementalArgs): IncrementalResult {
  ensureScopeDir(args.scope);

  // 1) 校验 source 块（必须先有首次导入）
  const existingSource = getSource(args.scope);
  if (!existingSource) {
    throw new Error(
      `scope "${args.scope}" 尚未首次导入，无法执行增量。请先执行 scan-kb import 完成全量导入。`
    );
  }

  // 2) 解析 ai-results
  const results: AiResultsFile = normalizeAiResults(args.resultsFile);
  if (args.sourceDirOverride) results.meta.sourceDir = args.sourceDirOverride;
  if (args.rootNameOverride) results.meta.rootName = args.rootNameOverride;

  if (!fs.existsSync(results.meta.sourceDir) || !fs.statSync(results.meta.sourceDir).isDirectory()) {
    throw new Error(`meta.sourceDir 不存在或不是目录：${results.meta.sourceDir}`);
  }
  // 增量模式下 rootName 必须与首次一致
  if (results.meta.rootName !== existingSource.rootName) {
    throw new Error(
      `meta.rootName="${results.meta.rootName}" 与首次导入的 rootName="${existingSource.rootName}" 不一致`
    );
  }

  // 3) 读 group-index + relations-cache
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readJson<GroupIndex>(groupIndexPath);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error('scope 缺少 group-index.json 或 relations-cache.json');
  }

  // 4) 分类
  const cls = classifyEntries(results.entries);
  const errors: { path: string; error: string }[] = [];
  const groupsTouched = new Set<string>();
  const memOpts: BatchVectorizeOptions = { timeoutMs: 60_000 };

  let added = 0;
  let modified = 0;
  let deleted = 0;

  // 5) 处理 add
  for (const e of cls.add) {
    const r = vectorizeOne(e, args.scope, memOpts);
    if (!r.ok) {
      errors.push({ path: e.path, error: r.error });
      continue;
    }
    ensureGroupPathInTree(groupIndex, e.groupPath);
    groupsTouched.add(e.groupPath);
    const relationText = deriveRelationText(e.path);
    upsertRelation(relationsCache, e.groupPath, relationText, e.keywords || [], r.memoryId, e.path);
    const absPath = path.resolve(results.meta.sourceDir, e.path);
    const moduleInfo = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : (e.summary || '');
    writeLocalKb(args.scope, e.groupPath, relationText, moduleInfo);
    added++;
  }

  // 6) 处理 modify：先 mem delete oldId，再 mem store 拿 newId
  for (const e of cls.modify) {
    if (!e.memoryId) {
      // 没有旧 id，降级为 add
      const r = vectorizeOne(e, args.scope, memOpts);
      if (!r.ok) {
        errors.push({ path: e.path, error: `[降级 add] ${r.error}` });
        continue;
      }
      ensureGroupPathInTree(groupIndex, e.groupPath);
      groupsTouched.add(e.groupPath);
      const relationText = deriveRelationText(e.path);
      upsertRelation(relationsCache, e.groupPath, relationText, e.keywords || [], r.memoryId, e.path);
      const absPath = path.resolve(results.meta.sourceDir, e.path);
      const moduleInfo = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : (e.summary || '');
      writeLocalKb(args.scope, e.groupPath, relationText, moduleInfo);
      added++;
      continue;
    }

    // 删除旧（失败不阻塞，仅记录 warning）
    const del = deleteMemory(e.memoryId, memOpts);
    if (!del.ok) {
      errors.push({ path: e.path, error: `[modify warn] mem delete oldId 失败：${del.error}` });
    }
    // 写新
    const r = vectorizeOne(e, args.scope, memOpts);
    if (!r.ok) {
      errors.push({ path: e.path, error: r.error });
      continue;
    }
    ensureGroupPathInTree(groupIndex, e.groupPath);
    groupsTouched.add(e.groupPath);
    const relationText = deriveRelationText(e.path);
    upsertRelation(relationsCache, e.groupPath, relationText, e.keywords || [], r.memoryId, e.path);
    const absPath = path.resolve(results.meta.sourceDir, e.path);
    const moduleInfo = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : (e.summary || '');
    writeLocalKb(args.scope, e.groupPath, relationText, moduleInfo);
    modified++;
  }

  // 7) 处理 delete
  for (const e of cls.delete) {
    if (!e.memoryId) {
      // S-02 已经校验，不应到这里；防御
      errors.push({ path: e.path, error: 'delete 条目缺少 memoryId' });
      continue;
    }
    const del = deleteMemory(e.memoryId, memOpts);
    if (!del.ok) {
      errors.push({ path: e.path, error: `[delete warn] mem delete 失败：${del.error}` });
      // 仍尝试清理索引
    }
    const relationText = deriveRelationText(e.path);
    const removedFromCache = removeFromCache(relationsCache, e.path);
    if (!removedFromCache) {
      errors.push({ path: e.path, error: `[delete warn] relations-cache 中未找到 sourcePath=${e.path}` });
    }
    removeFromLocalKb(args.scope, e.groupPath, relationText);
    deleted++;
  }

  // 8) 持久化
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);

  // 9) 更新 source.commit
  const newCommit = getGitHead(results.meta.sourceDir);
  if (!newCommit) {
    throw new Error(`无法获取 sourceDir 的 git HEAD：${results.meta.sourceDir}`);
  }
  const newSource = { ...existingSource, commit: newCommit };
  setSource(args.scope, newSource);

  return {
    ok: true,
    action: 'import',
    mode: 'incremental',
    scope: args.scope,
    stats: {
      total: results.entries.length,
      added,
      modified,
      deleted,
      errors: errors.length,
    },
    errors,
    groups: [...groupsTouched].sort(),
    source: newSource,
    previousCommit: existingSource.commit,
    newCommit,
  };
}
