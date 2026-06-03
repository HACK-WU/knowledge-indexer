/**
 * batch-vectorize.ts —— S-03：批量调用 `mem store` 完成 entries 向量化
 *
 * 设计要点：
 *   - 串行执行（避免 LanceDB write lock）
 *   - 通过 stdout `Memory ID: <id>` 行（由 src/cli.ts 输出）解析 memoryId
 *   - 失败条目记入 errors，不中断整体
 *   - 默认 category=kb-import，便于后续清理/统计
 *   - 不处理 action=delete 条目（调用方过滤）
 */

import { execFileSync } from 'child_process';

import type { ScanResultEntry } from './ai-results.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATEGORY = 'kb-import';
const MEMORY_ID_PATTERN = /^[ \t]*Memory ID:[ \t]*(\S+)[ \t]*$/m;

export interface BatchVectorizeResult {
  /** path → memoryId（成功条目） */
  ok: Map<string, string>;
  errors: { path: string; error: string }[];
}

export interface BatchVectorizeOptions {
  /** 每条 mem store 超时 (ms)，默认 30000 */
  timeoutMs?: number;
  /** memory category，默认 kb-import */
  category?: string;
}

/**
 * 构造 mem store 的 content 文本
 *   [摘要] ...
 *   [关键词] k1, k2
 *   [路径] xxx
 */
export function buildVectorizeContent(entry: ScanResultEntry): string {
  const kw = (entry.keywords || []).join(', ');
  return `[摘要] ${entry.summary}\n[关键词] ${kw}\n[路径] ${entry.path}`;
}

/** 从 mem store stdout 提取 memoryId */
export function parseMemoryId(stdout: string): string | null {
  const m = stdout.match(MEMORY_ID_PATTERN);
  return m ? m[1] : null;
}

/**
 * 单条向量化
 * 内部使用，便于 S-06 modify/add 单条调用
 */
export function vectorizeOne(
  entry: ScanResultEntry,
  scope: string,
  options: BatchVectorizeOptions = {}
): { ok: true; memoryId: string } | { ok: false; error: string } {
  const category = options.category || DEFAULT_CATEGORY;
  const timeout = options.timeoutMs || parseInt(process.env.MEM_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  const content = buildVectorizeContent(entry);

  try {
    const stdout = execFileSync(
      'mem',
      ['store', content, '--scope', scope, '--category', category],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }
    );
    const id = parseMemoryId(stdout);
    if (!id) {
      return { ok: false, error: `无法从 stdout 解析 memoryId（缺少 "Memory ID:" 行）` };
    }
    return { ok: true, memoryId: id };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    // 子进程返回非 0：可能 stdout 仍含 Memory ID（理论上 store 失败不会有），尝试一次
    const idMaybe = parseMemoryId(stdout);
    if (idMaybe) {
      return { ok: true, memoryId: idMaybe };
    }
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    return {
      ok: false,
      error: `mem store 失败${statusInfo}: ${e.message || ''}${stderr ? `\nstderr=${stderr.trim()}` : ''}`.trim(),
    };
  }
}

/**
 * 批量向量化
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @returns        ok Map（成功）+ errors（失败明细）
 */
export function batchVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): BatchVectorizeResult {
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];

  for (const entry of entries) {
    if (entry.action === 'delete') {
      // 调用方未过滤，跳过以容错
      continue;
    }
    const r = vectorizeOne(entry, scope, options);
    if (r.ok) {
      ok.set(entry.path, r.memoryId);
    } else {
      errors.push({ path: entry.path, error: r.error });
    }
  }

  return { ok, errors };
}

/**
 * 删除单条记忆（S-06 modify/delete 路径使用）
 */
export function deleteMemory(
  memoryId: string,
  options: BatchVectorizeOptions = {}
): { ok: boolean; error?: string } {
  const timeout = options.timeoutMs || parseInt(process.env.MEM_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  try {
    execFileSync('mem', ['delete', memoryId], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    return { ok: false, error: `mem delete ${memoryId} 失败${statusInfo}: ${e.message}${stderr ? `\nstderr=${stderr.trim()}` : ''}`.trim() };
  }
}
