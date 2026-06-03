/**
 * import.ts —— S-04：统一导入命令的核心实现
 *
 * 5 个 Phase：
 *   Phase 1: validateAndNormalize  → 读 ai-results.json，校验 + 补全
 *   Phase 2: batchVectorize         → 调 mem store 批量向量化
 *   Phase 3: ensureGroups           → 按 groupPath 建 Group 树
 *   Phase 4: writeRelations         → 写 relations-cache + local KB（含 memoryId/sourcePath）
 *   Phase 5: recordSource           → 写 group-index.source 块（含 git HEAD commit）
 *
 * 仅处理 full 模式；增量模式由 S-06 在此基础上扩展。
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
  type GroupIndexSource,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir } from './store.js';
import { DEFAULT_PARTITION_CONFIG, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';

import { normalizeAiResults, type AiResultsFile, type ScanResultEntry } from './ai-results.js';
import { batchVectorize, type BatchVectorizeResult } from './batch-vectorize.js';

// ─── 类型 ───────────────────────────────────────────────

export interface GroupIndex {
  version: number;
  scope: string;
  roots: Record<string, Record<string, unknown>>;
  updatedAt: string | null;
  source?: GroupIndexSource | null;
}

export interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
  max_hot_count: number;
}

export interface RelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

export interface ImportContext {
  scope: string;
  sourceDir: string;
  rootName: string;
  entries: ScanResultEntry[];
  /** path → memoryId（成功向量化的条目） */
  memoryMap: Map<string, string>;
  /** Phase 3 创建/确认的 Group 路径（含 rootName 前缀） */
  groups: Set<string>;
  /** mapping 模式：path → relationText（覆盖默认推导） */
  mapping?: Map<string, MappingTarget>;
}

export interface ImportStats {
  total: number;
  vectorized: number;
  errors: number;
}

export interface ImportResult {
  ok: true;
  action: 'import';
  mode: 'full' | 'incremental';
  scope: string;
  stats: ImportStats;
  errors: { path: string; error: string }[];
  groups: string[];
  source: GroupIndexSource;
}

export interface MappingTarget {
  groupPath: string;        // 含 rootName 前缀的完整 group path
  relation: string;
  codeRefs?: string[];
}

interface MappingFileSource {
  file: string;
  relation: string;
  code_refs?: string[];
}
interface MappingFileGroup {
  path: string;
  sources: MappingFileSource[];
}
interface MappingFile {
  root_name?: string;
  groups?: MappingFileGroup[];
}

export interface HandleImportArgs {
  scope: string;
  resultsFile: string;
  /** 强制覆盖 ai-results.meta.sourceDir（一般无需传） */
  sourceDirOverride?: string;
  /** 强制覆盖 ai-results.meta.rootName（一般无需传） */
  rootNameOverride?: string;
  /** mapping 文件路径 */
  mappingFile?: string;
}

// ─── 工具函数 ───────────────────────────────────────────

function trimSlashes(input: string): string {
  return input.replace(/^\/+|\/+$/g, '');
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 从 entry.path 推导 relation 文本（剥 .md + 去掉 markdown 强格式字符） */
function deriveRelationText(filePath: string): string {
  const base = stripMarkdownExtension(path.posix.basename(filePath));
  const cleaned = base.replace(/[*~`]/g, '').trim();
  return cleaned || base;
}

/** 把 commit hash 取出来，失败返回 null */
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

// ─── Group 树构建 ───────────────────────────────────────

function ensureGroupPathInTree(index: GroupIndex, groupPath: string): boolean {
  const segments = trimSlashes(groupPath).split('/').filter(Boolean);
  if (segments.length === 0) return false;

  if (!index.roots[segments[0]]) {
    index.roots[segments[0]] = {};
  }
  let current: Record<string, unknown> = index.roots[segments[0]];
  let created = false;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
      created = true;
    }
    current = current[seg] as Record<string, unknown>;
  }
  return created;
}

// ─── relations-cache 操作 ───────────────────────────────

function ensureCacheGroup(cache: RelationsCache, groupPath: string): GroupData {
  if (!cache.groups[groupPath]) {
    cache.groups[groupPath] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: (cache.partition_config || DEFAULT_PARTITION_CONFIG).maxHotCount,
    };
  }
  return cache.groups[groupPath];
}

function generateNextId(cache: RelationsCache): string {
  let maxNum = 0;
  for (const data of Object.values(cache.groups)) {
    for (const rel of data.hot_relations) {
      const m = rel.id.match(/^rel_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
  }
  return `rel_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * upsert：以 (groupPath + relationText) 为主键
 * 注意 sourcePath 是更可靠的主键（避免不同目录同名文件冲突），但为兼容
 * 既有 import-kb 行为，仍以 relationText 作为去重维度。
 */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  keywords: string[],
  memoryId: string | null | undefined,
  sourcePath: string | null | undefined
): void {
  const groupData = ensureCacheGroup(cache, groupPath);
  let rel = groupData.hot_relations.find((r) => r.text === relationText);

  if (!rel) {
    rel = {
      id: generateNextId(cache),
      text: relationText,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
    };
    groupData.hot_relations.push(rel);
  } else {
    // 已存在：刷新为导入态，不做评分回退（与 import-kb 行为一致）
    rel.isImported = true;
  }
  if (memoryId) rel.memoryId = memoryId;
  if (sourcePath) rel.sourcePath = sourcePath;

  // keywords 合并去重到 Group 级
  for (const kw of keywords || []) {
    const t = String(kw).trim();
    if (t && !groupData.keywords.includes(t)) {
      groupData.keywords.push(t);
    }
  }
  const maxKw = (cache.partition_config || DEFAULT_PARTITION_CONFIG).maxKeywordCount;
  if (groupData.keywords.length > maxKw) {
    groupData.keywords.splice(0, groupData.keywords.length - maxKw);
  }
}

// ─── local KB 操作 ───────────────────────────────────────

function loadLocalKb(localKbPath: string): Record<string, unknown> {
  if (!fs.existsSync(localKbPath)) return {};
  return readJson<Record<string, unknown>>(localKbPath) || {};
}

function appendCodeRefs(moduleInfo: string, codeRefs?: string[]): string {
  if (!codeRefs || codeRefs.length === 0) return moduleInfo;
  const refs = codeRefs.map((s) => s.trim()).filter(Boolean);
  if (refs.length === 0) return moduleInfo;
  return `${moduleInfo}\n\n## 代码定位\n${refs.map((r) => `- ${r}`).join('\n')}`;
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

// ─── mapping 解析 ───────────────────────────────────────

function loadMappingFile(filePath: string, rootName: string): {
  rootName: string;
  byPath: Map<string, MappingTarget>;
} {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as MappingFile;
  const finalRoot = (data.root_name && data.root_name.trim()) || rootName;
  const byPath = new Map<string, MappingTarget>();

  for (const group of data.groups || []) {
    const trimmed = trimSlashes(String(group.path || ''));
    let normalized = trimmed;
    if (trimmed) {
      const segs = trimmed.split('/').filter(Boolean);
      if (segs[0] === finalRoot) {
        // 用户已带 rootName 前缀：去重
        normalized = segs.slice(1).join('/');
      }
    }
    const fullGroupPath = normalized ? `${finalRoot}/${normalized}` : finalRoot;

    for (const src of group.sources || []) {
      const filePosix = toPosix(String(src.file || ''));
      if (!filePosix) continue;
      byPath.set(filePosix, {
        groupPath: fullGroupPath,
        relation: String(src.relation || '').replace(/[*~`]/g, '').trim(),
        codeRefs: src.code_refs,
      });
    }
  }

  return { rootName: finalRoot, byPath };
}

// ─── Phase 实现 ─────────────────────────────────────────

/** Phase 1: 校验 + 归一化 */
function phase1Validate(args: HandleImportArgs): {
  results: AiResultsFile;
  mapping?: Map<string, MappingTarget>;
} {
  const results = normalizeAiResults(args.resultsFile);
  // override
  if (args.sourceDirOverride) results.meta.sourceDir = args.sourceDirOverride;
  if (args.rootNameOverride) results.meta.rootName = args.rootNameOverride;

  // sourceDir 必须存在
  if (!fs.existsSync(results.meta.sourceDir) || !fs.statSync(results.meta.sourceDir).isDirectory()) {
    throw new Error(`meta.sourceDir 不存在或不是目录：${results.meta.sourceDir}`);
  }

  let mapping: Map<string, MappingTarget> | undefined;
  if (args.mappingFile) {
    if (!fs.existsSync(args.mappingFile)) {
      throw new Error(`mapping 文件不存在：${args.mappingFile}`);
    }
    const m = loadMappingFile(args.mappingFile, results.meta.rootName);
    // mapping 中的 root_name 优先级最高
    results.meta.rootName = m.rootName;
    mapping = m.byPath;
  }

  return { results, mapping };
}

/** Phase 2: 批量向量化（已封装 S-03）*/
function phase2Vectorize(
  entries: ScanResultEntry[],
  scope: string
): BatchVectorizeResult {
  // full 模式下应当全部 action='add'，但允许 modify/delete 也通过（filter delete）
  const toVectorize = entries.filter((e) => e.action !== 'delete');
  return batchVectorize(toVectorize, scope, { timeoutMs: 60_000 });
}

/** Phase 3: ensure groups */
function phase3EnsureGroups(
  ctx: ImportContext,
  groupIndex: GroupIndex
): void {
  // root 节点
  if (!groupIndex.roots[ctx.rootName]) {
    groupIndex.roots[ctx.rootName] = {};
  }
  ctx.groups.add(ctx.rootName);

  for (const e of ctx.entries) {
    const target = ctx.mapping?.get(e.path);
    const groupPath = target ? target.groupPath : e.groupPath;
    ensureGroupPathInTree(groupIndex, groupPath);
    ctx.groups.add(groupPath);
  }
}

/** Phase 4: 写 relations-cache + local KB */
function phase4WriteRelations(
  ctx: ImportContext,
  cache: RelationsCache
): void {
  for (const e of ctx.entries) {
    if (e.action === 'delete') continue;
    const memoryId = ctx.memoryMap.get(e.path) || e.memoryId || null;

    const target = ctx.mapping?.get(e.path);
    const groupPath = target ? target.groupPath : e.groupPath;
    const relationText = target?.relation || deriveRelationText(e.path);

    upsertRelation(cache, groupPath, relationText, e.keywords || [], memoryId, e.path);

    // local KB 写文件实体
    const absPath = path.resolve(ctx.sourceDir, e.path);
    let moduleInfo: string;
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      moduleInfo = fs.readFileSync(absPath, 'utf-8');
    } else {
      // 文件不存在时退化为只用 summary，避免 fail
      moduleInfo = e.summary || '';
    }
    if (target?.codeRefs) {
      moduleInfo = appendCodeRefs(moduleInfo, target.codeRefs);
    }
    writeLocalKb(ctx.scope, groupPath, relationText, moduleInfo);
  }
}

/** Phase 5: 记录 source */
function phase5RecordSource(scope: string, sourceDir: string, rootName: string): GroupIndexSource {
  const head = getGitHead(sourceDir);
  if (!head) {
    throw new Error(`source.dir 不在 git 仓库中或无法获取 HEAD：${sourceDir}`);
  }
  const source: GroupIndexSource = {
    dir: path.resolve(sourceDir),
    rootName,
    commit: head,
  };
  setSource(scope, source);
  return source;
}

// ─── 主入口 ─────────────────────────────────────────────

export function handleImport(args: HandleImportArgs): ImportResult {
  // 0) 准备 scope 目录
  ensureScopeDir(args.scope);

  // Phase 1
  const { results, mapping } = phase1Validate(args);
  const total = results.entries.length;

  // Phase 2
  const vec = phase2Vectorize(results.entries, args.scope);

  const ctx: ImportContext = {
    scope: args.scope,
    sourceDir: results.meta.sourceDir,
    rootName: results.meta.rootName,
    entries: results.entries,
    memoryMap: vec.ok,
    groups: new Set<string>(),
    mapping,
  };

  // 读取 group-index + relations-cache
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readJson<GroupIndex>(groupIndexPath);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error('scope 初始化失败：缺少 group-index.json 或 relations-cache.json');
  }

  // Phase 3
  phase3EnsureGroups(ctx, groupIndex);

  // Phase 4 — 只处理向量化成功（或本身不需向量化）的条目
  const successfulEntries = ctx.entries.filter((e) => {
    if (e.action === 'delete') return false;
    return ctx.memoryMap.has(e.path);
  });
  ctx.entries = successfulEntries;
  phase4WriteRelations(ctx, relationsCache);

  // 持久化
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);

  // Phase 5
  const source = phase5RecordSource(args.scope, results.meta.sourceDir, results.meta.rootName);

  return {
    ok: true,
    action: 'import',
    mode: 'full',
    scope: args.scope,
    stats: {
      total,
      vectorized: vec.ok.size,
      errors: vec.errors.length,
    },
    errors: vec.errors,
    groups: [...ctx.groups].sort(),
    source,
  };
}
