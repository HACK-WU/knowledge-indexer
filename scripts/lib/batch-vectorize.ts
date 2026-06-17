/**
 * batch-vectorize.ts —— S-03：批量调用 `mem store` / `mem bulk-store` 完成 entries 向量化
 *
 * 设计要点：
 *   - bulkVectorize（推荐）：一次 `mem bulk-store` 进程写入全部条目，消除 N 次进程启动 + N 次锁获取
 *   - batchVectorize（兼容）：串行逐条 `mem store`，用于增量等小批量场景
 *   - vectorizeOne：单条向量化，增量 modify 使用
 *   - 通过 stdout `Memory ID: <id>` 行（由 src/cli.ts 输出）解析 memoryId
 *   - 失败条目记入 errors，不中断整体
 *   - 默认 category=kb-import，便于后续清理/统计
 *   - 不处理 action=delete 条目（调用方过滤）
 */

import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

/** bulk-store --json 输出结构 */
interface BulkStoreJsonResult {
  total: number;
  ok: number;
  errors: number;
  skipped: number;
  elapsedSeconds: number;
  details: {
    ok: { index: number; text: string; id: string }[];
    errors: { index: number; text: string; error: string }[];
    skipped: { index: number; text: string; reason: string }[];
  };
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
      ['store', content, '--scope', scope, '--category', category, '--tags', 'ki-search'],
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

/**
 * 批量向量化（使用 mem bulk-store）
 *
 * 一次进程写入全部条目，消除 N 次进程启动 + N 次文件锁获取的开销。
 * 100 条从 ~300s（串行 mem store）降至 ~30-50s（单进程 bulk-store）。
 *
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @param options  选项
 * @returns        ok Map（成功）+ errors（失败明细）
 */
export function bulkVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): Promise<BatchVectorizeResult> {
  return new Promise((resolve) => {
    const ok = new Map<string, string>();
    const errors: { path: string; error: string }[] = [];

    if (entries.length === 0) { resolve({ ok, errors }); return; }

    const category = options.category || DEFAULT_CATEGORY;
    const timeout = options.timeoutMs
      || parseInt(process.env.MEM_BULK_TIMEOUT_MS || '', 10)
      || (60_000 + entries.length * 10_000);

    // 1) 构建批量存储的 JSON 数组
    const bulkEntries = entries.map((entry) => ({
      text: buildVectorizeContent(entry),
      tags: 'ki-search',
      category,
      scope,
    }));

    // 2) 写入临时文件
    const tmpFile = path.join(os.tmpdir(), `mem-bulk-${scope}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(bulkEntries), 'utf-8');
    } catch (err) {
      const e = err as Error;
      for (const entry of entries) {
        errors.push({ path: entry.path, error: `写入临时文件失败: ${e.message}` });
      }
      resolve({ ok, errors });
      return;
    }

    // 3) 使用 spawn 异步执行 mem bulk-store（不带 --json）
    //    mem 的正常进度行输出到 stdout：[1/5] ✅ 内容 → memoryId
    //    逐行实时转发到终端，同时解析 index + memoryId 构建结果。
    const child = spawn('mem', ['bulk-store', '-f', tmpFile, '--scope', scope], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let stderrBuf = '';  // 环形缓冲：只保留最后 4000 字节，用于错误诊断
    let stdoutLineBuf = '';
    // 匹配进度状态行: [1/137] ✅ ...  或  [4/5] ❌ ...
    // 只判断成功/失败，不提取 memoryId（搜索不依赖 ID，断点续跑只看 path）
    const STATUS_PATTERN = /^\[(\d+)\/\d+\]\s+(✅|❌|⏭️)/;
    // 收集每条的结果: index → { ok, error? }
    const perEntryResults = new Map<number, { ok: boolean; error?: string }>();

    // 实时转发 stderr 到终端（环形缓冲：只保留最后 4000 字节，确保真正的错误信息不被截断）
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 4000) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - 4000);
      }
      process.stderr.write(text);
    });

    // 逐行处理 stdout，实时显示进度
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split('\n');
      stdoutLineBuf += lines[0];
      for (let i = 1; i < lines.length; i++) {
        processLine(stdoutLineBuf);
        stdoutLineBuf = lines[i];
      }
    });

    function processLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      // 进度行实时转发到终端
      if (trimmed.startsWith('[') || trimmed.startsWith('─') || trimmed.startsWith('Bulk store') || trimmed.startsWith('✅ Stored') || trimmed.startsWith('❌ Error') || trimmed.startsWith('Processed:') || trimmed.startsWith('⏭')) {
        process.stderr.write(line + '\n');
      }
      // 解析状态行，只判断成功/失败
      const m = trimmed.match(STATUS_PATTERN);
      if (m) {
        const idx = parseInt(m[1], 10) - 1; // 转为 0-based
        const status = m[2];
        if (status === '✅') {
          perEntryResults.set(idx, { ok: true });
        } else if (status === '❌') {
          perEntryResults.set(idx, { ok: false, error: 'bulk-store failed' });
        } else if (status === '⏭️') {
          perEntryResults.set(idx, { ok: false, error: 'skipped' });
        }
      }
    }

    let hasError = false;

    child.on('error', (err) => {
      hasError = true;
      const errMsg = `mem bulk-store 启动失败: ${err.message}`;
      for (const entry of entries) {
        errors.push({ path: entry.path, error: errMsg });
      }
      cleanup(tmpFile);
      resolve({ ok, errors });
    });

    child.on('close', (code) => {
      // error 事件已处理，close 只需收尾
      if (hasError) return;
      // 输出最后一行
      processLine(stdoutLineBuf);

      if (code !== 0 && code !== null && perEntryResults.size === 0) {
        // 进程异常退出且无任何结果
        const errMsg = `mem bulk-store 失败 exitCode=${code}${stderrBuf ? ': ' + stderrBuf.trim().slice(0, 300) : ''}`;
        for (const entry of entries) {
          errors.push({ path: entry.path, error: errMsg });
        }
        cleanup(tmpFile);
        resolve({ ok, errors });
        return;
      }

      // 4) 从逐行解析结果构建 ok/errors
      //    成功条目的 ID 用 path 短 hash 占位（搜索不依赖真实 memoryId，断点续跑只看 path）
      for (let i = 0; i < entries.length; i++) {
        const result = perEntryResults.get(i);
        if (result?.ok) {
          const fakeId = crypto.createHash('md5').update(entries[i].path).digest('hex').slice(0, 16);
          ok.set(entries[i].path, fakeId);
        } else if (result && !result.ok) {
          errors.push({ path: entries[i].path, error: result.error || 'unknown error' });
        }
        // 未出现在进度中的条目视为未知错误
        else if (!result) {
          errors.push({ path: entries[i].path, error: 'bulk-store 未处理此条目' });
        }
      }

      cleanup(tmpFile);
      resolve({ ok, errors });
    });
  });
}

/** 清理临时文件 */
function cleanup(tmpFile: string) {
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
}
