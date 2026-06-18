# 设计文档：向量存储与KB写入并行化优化

> 状态：草案
> 需求：REQ-20260618-001
> 版本：1
> 日期：2026-06-18

## 1. 需求背景 & 目标

ki 的双记忆系统由两条独立数据通道组成：

| 通道 | 存储 | 消费方 | 延迟 |
|------|------|--------|------|
| KB 通道 | relations-cache + local KB + wiki | query-group, get-module-info | <30ms |
| 向量通道 | mem CLI (ki-relation + ki-search) | search（语义检索） | 2-10s/次 |

当前实现将两条通道串行执行，导致 sync_relation 单次调用 4-20s、import 批量导入效率低。

**目标**：
- sync_relation：KB 写入完成后立即返回，向量异步执行
- import：Phase2（向量化）与 Phase3/4（KB写入）并行执行
- memoryId：新 relation 不再写入无用的 memoryId 字段

**不在范围内**：
- mem CLI 内部改造（HTTP 长驻进程等）
- 旧 relation 的 memoryId 批量清理/迁移
- 向量索引重建

## 2. 现状分析（AS-IS）

### 2.1 sync_relation 执行流

文件：`scripts/sync-relation.ts` → `executeSyncRelation()`

```
executeSyncRelation(params)
  ├── validateScope + ensureScopeDir          ← ~5ms
  ├── readJson(cachePath)                     ← ~5ms
  ├── readGroupIndex(scope)                   ← ~5ms
  ├── syncSingleRelation(...)                 ← ~10ms (缓存 + 本地KB)
  │     ├── ensureGroupPath(scope, group)
  │     ├── 创建/更新 Relation + 排序
  │     ├── 合并 keywords
  │     └── writeJson(localKbPath, localKb)
  ├── writeJson(cachePath, cache)             ← WAL 持久化 ~5ms
  │
  │   ── 以下两步串行阻塞 ──
  ├── storeOnePath(...)                       ← mem store ki-relation  2-10s
  │     └── execFileSync('mem', ['store', ...])
  ├── memStore(...)                           ← mem store ki-search    2-10s
  │     └── execFileSync('mem', ['store', ...])
  │
  └── writeBackToWiki(...)                    ← ~5ms
```

**瓶颈**：`storeOnePath` + `memStore` 串行执行，每次 `execFileSync` 阻塞主线程 2-10s。

### 2.2 scan-kb import 执行流

文件：`scripts/lib/import.ts` → `handleImport()`

```
handleImport(args)
  ├── Phase 1: validate + normalize           ← ~5ms
  ├── Phase 2: bulkVectorize                   ← mem bulk-store  30-90s
  │     └── bulkStorePaths(pathEntries)        ← 路径向量 10-30s
  │
  │   ── Phase 3/4 必须等 Phase 2 完成 ──
  ├── Phase 3: ensureGroups                    ← ~5ms
  ├── Phase 4: writeRelations + local KB       ← ~10ms
  ├── Phase 5: recordSource                    ← ~5ms
  └── cleanProgressFile
```

**瓶颈**：Phase 2 向量化（30-90s）完成后才执行 Phase 3/4（<20ms），串行浪费。

### 2.3 memoryId 死数据

`upsertRelation()` 在 import 时将 `memoryId` 写入 relation 对象。查询链路（query-group, search）完全不读取此字段。增量 delete/modify 用的是 scan-index.json 的 memoryId，与 relations-cache 无关。

## 3. 方案设计（TO-BE）

### 3.1 总体架构

```
flowchart TB
    subgraph SyncRelation["sync_relation 新流程"]
        S1["KB 写入（同步）"] --> S2["立即返回结果"]
        S1 -.->|"fire-and-forget"| S3["向量存储（后台）"]
    end

    subgraph Import["import 新流程"]
        I1["Phase 2: 向量化"] --> I3["合并结果"]
        I2["Phase 3+4: Group树 + KB"] --> I3
        I1 -.->|"并行"| I2
    end
```

### 3.2 核心原则

1. **同步阻塞仅限核心路径**：只有 KB 通道写入保持同步（保证数据完整性）
2. **向量写入不阻塞返回**：sync_relation 异步 fire-and-forget，import 并行 Promise.all
3. **失败不阻塞**：向量写入失败只记 stderr 警告（已有 try-catch 设计）
4. **接口向后兼容**：memoryId 旧数据不删除，新数据不写入

## 4. S-01: sync_relation 异步向量化

### 4.1 变更文件

- `scripts/sync-relation.ts` → `executeSyncRelation()`

### 4.2 变更策略

将 `executeSyncRelation` 中的两个向量写入操作从同步改为异步：

**AS-IS**（第 446-467 行）：
```typescript
// 同步阻塞
storeOnePath({ text: relText, tag: 'ki-relation', scope });
// ↓ 等待完成
memStore({ scope, text: moduleInfo, keywords: keywordList, tags: 'ki-search' });
// ↓ 等待完成
return result;
```

**TO-BE**：
```typescript
// KB 写入完成后先返回
const baseResult = { ok: true, ...result, ...(pathHint ? { hint: pathHint } : {}) };

// 向量写入异步执行（不阻塞返回）
fireAndForgetVectorOps(scope, relation, group, keywordList, moduleInfo);

return baseResult;
```

### 4.3 异步执行函数

新增 `fireAndForgetVectorOps` 函数：

```typescript
function fireAndForgetVectorOps(
  scope: string,
  relation: string,
  group: string,
  keywordList: string[],
  moduleInfo: string
): void {
  // 使用 Promise 微任务，不阻塞当前调用栈
  Promise.resolve().then(async () => {
    // ki-relation 向量
    try {
      const relText = buildRelationContent(relation, group, keywordList);
      storeOnePath({ text: relText, tag: 'ki-relation', scope });
    } catch {
      // 向量写入失败不影响主流程
    }

    // ki-search 通用语义向量
    try {
      const avail = ensureMemAvailable();
      if (avail.available) {
        memStore({
          scope,
          text: moduleInfo,
          keywords: keywordList,
          tags: 'ki-search',
        });
      }
    } catch (err) {
      console.warn(`[sync-relation] 向量异步写入失败: ${(err as Error).message}`);
    }
  });
}
```

**设计要点**：
- `Promise.resolve().then()` 将向量写入推迟到当前事件循环结束后执行
- MCP server 是长驻进程，异步任务自然能完成
- CLI 模式下进程可能在异步任务完成前退出，但 CLI 的主要使用场景是 import（用同步模式），sync_relation 主要通过 MCP 调用

### 4.4 返回结构变更

| 字段 | AS-IS | TO-BE |
|------|-------|-------|
| `vectorStored` | boolean \| undefined | **移除**（异步无法确定） |
| `vectorPending` | 不存在 | **新增** `true` |

返回示例：
```json
{
  "ok": true,
  "relation": "告警收敛服务",
  "keywords": ["告警收敛", "降噪"],
  "invalid_keywords": [],
  "evicted": null,
  "hint": "...",
  "vectorPending": true,
  "wikiSynced": true,
  "wikiFile": "/path/to/file.md"
}
```

## 5. S-02: import Phase 并行化

### 5.1 变更文件

- `scripts/lib/import.ts` → `handleImport()`

### 5.2 变更策略

将 Phase 2（向量化）与 Phase 3/4（Group树+KB）并行执行。

**AS-IS**（串行）：
```
Phase 2: await phase2Vectorize(...)        ← 阻塞 30-90s
  ↓
路径向量: bulkStorePaths(pathEntries)      ← 阻塞 10-30s
  ↓
Phase 3: phase3EnsureGroups(...)           ← ~5ms
Phase 4: phase4WriteRelations(...)         ← ~10ms
```

**TO-BE**（并行）：
```
┌─ Phase 2: await phase2Vectorize(...) ───┐
│ + 路径向量: bulkStorePaths(...)          │  并行
│                                          │
│ Phase 3: phase3EnsureGroups(...)         │
│ Phase 4: phase4WriteRelations(...)       │
└──────────────────────────────────────────┘
  ↓ 合并结果
Phase 5: recordSource
```

### 5.3 并行化代码

```typescript
// Phase 2 与 Phase 3/4 并行
const [vectorizeResult, kbResult] = await Promise.all([
  // 分支 A: 向量化 + 路径向量
  (async () => {
    const { vec, skippedFromProgress } = await phase2Vectorize(
      results.entries, args.scope, results.meta.rootName, TOTAL_PHASES
    );

    // 路径向量写入
    if (pathEntries.length > 0) {
      logInfo(`写入路径向量索引（${pathEntries.length} 条）...`);
      bulkStorePaths(pathEntries);
    }

    return { vec, skippedFromProgress };
  })(),

  // 分支 B: Group 树 + KB 写入
  (async () => {
    const ctx: ImportContext = { /* ... */ };
    const groupIndex = readGroupIndex(args.scope);
    const relationsCache = readJson<RelationsCache>(relationsCachePath);

    phase3EnsureGroups(ctx, groupIndex);
    phase4WriteRelations(ctx, relationsCache);

    // 持久化
    writeJson(groupIndexPath, groupIndex as Record<string, unknown>);
    writeJson(relationsCachePath, relationsCache as Record<string, unknown>);

    return { ctx, groupIndex };
  })(),
]);

// 合并 memoryMap
const mergedMap = new Map([...vectorizeResult.skippedFromProgress, ...vectorizeResult.vec.ok]);

// Phase 5: 记录 source
const source = phase5RecordSource(args.scope, results.meta.sourceDir, results.meta.rootName);
```

### 5.4 Phase 4 条目过滤逻辑变更

当前 Phase 4 有 `successfulEntries` 过滤（import.ts 第 570-574 行）：

```typescript
// AS-IS：仅处理向量化成功的条目
const successfulEntries = ctx.entries.filter((e) => {
  if (e.action === 'delete') return false;
  return ctx.memoryMap.has(e.path);  // 依赖 memoryMap
});
```

并行化后，Phase 4 在 Phase 2 完成前执行时 `memoryMap` 为空，会导致所有条目被过滤掉。

**TO-BE**：由于 S-03 不再写入 memoryId，此过滤逻辑改为仅排除 delete 条目：

```typescript
// TO-BE：所有非 delete 条目都写入 relations-cache
// 向量化失败不影响 KB 通道的写入（两通道独立）
const validEntries = ctx.entries.filter((e) => e.action !== 'delete');
ctx.entries = validEntries;
```

**行为变更**：之前向量化失败的条目不会写入 relations-cache；现在无论向量化是否成功，条目都会写入 KB。这是正确的——两通道互不依赖。

### 5.5 进度文件处理

进度文件逻辑不受影响：
- `phase2Vectorize` 内部负责读取/写入进度文件
- 进度文件仅在 Phase 2 完成时更新
- 并行化不影响进度文件的读写时序

## 6. S-03: memoryId 清理

### 6.1 变更文件

- `scripts/lib/import.ts` → `upsertRelation()`

### 6.2 变更策略

**AS-IS**：
```typescript
if (memoryId) rel.memoryId = memoryId;
```

**TO-BE**：
```typescript
// memoryId 已确认为死数据，不再写入 relation
// 旧数据中的 memoryId 保留不删除（兼容性）
// 迁移注意：增量 delete/modify 用的是 scan-index.json 的 memoryId，不受影响
if (sourcePath) rel.sourcePath = sourcePath;
```

直接删除 `if (memoryId) rel.memoryId = memoryId;` 行，无需额外的 `void` 操作。

### 6.3 兼容性处理

- **旧数据**：relations-cache 中已有的 `memoryId` 字段保留不删除
- **新数据**：通过 import 或 sync_relation 新增的 relation 不含 `memoryId`
- **读取方**：无。query-group、search、get-module-info 均不读取 relation.memoryId
- **scan-index.json**：其 memoryId 不受影响，增量 delete/modify 继续正常工作

## 7. 接口变更

### 7.1 executeSyncRelation 返回值

```typescript
// AS-IS
type SyncRelationResult =
  | { ok: true; relation: string; keywords: string[];
      invalid_keywords: string[]; evicted: string | null;
      hint?: string; vectorStored?: boolean;          // ← 移除
      wikiSynced?: boolean; wikiFile?: string; wikiReason?: string }
  | { ok: false; error: string };

// TO-BE
type SyncRelationResult =
  | { ok: true; relation: string; keywords: string[];
      invalid_keywords: string[]; evicted: string | null;
      hint?: string; vectorPending?: boolean;          // ← 新增
      wikiSynced?: boolean; wikiFile?: string; wikiReason?: string }
  | { ok: false; error: string };
```

### 7.2 Relation 数据结构

```typescript
interface Relation {
  id: string;
  text: string;
  score: number;
  useCount: number;
  lastUsedTime: number | null;
  isImported: boolean;
  memoryId?: string;      // 旧数据保留，新数据不再写入
  sourcePath?: string;    // 保留
}
```

## 8. 影响范围

| 文件 | 变更类型 | S-01 | S-02 | S-03 |
|------|----------|:----:|:----:|:----:|
| `scripts/sync-relation.ts` | 修改 | ✅ | | |
| `scripts/lib/import.ts` | 修改 | | ✅ | ✅ |

无新增文件。无删除文件。

## 9. 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|:---:|
| 向量写入失败（sync_relation 异步） | stderr 警告，不影响返回值 | 否 |
| 向量写入失败（import 并行） | 记入 errors 数组，不阻塞 KB 写入 | 是（返回结果中） |
| Phase 3/4 异常（import 并行） | Promise.all 拒绝，整体 import 失败 | 是 |
| 进程退出时异步任务未完成 | MCP server 长驻，通常不会发生；CLI 模式下向量可能丢失 | 否（设计允许） |

## 10. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|------|
| MCP server 异常退出导致向量丢失 | 低 | 低 | 向量丢失不影响 KB 完整性，后续 import 可补建 |
| import 并行化内存开销 | 低 | 低 | Phase 2 和 Phase 3/4 各自数据结构轻量（JSON 对象） |
| 旧 memoryId 残留影响 | 无 | 无 | 无读取方，纯粹是数据冗余 |

## 11. 非功能性假设

- **单机低量级**：ki 运行在单机环境，单用户低频调用
- **最终一致**：向量索引允许延迟写入，不要求与 KB 强一致
- **单点故障可接受**：mem CLI 不可用时降级为仅 KB 写入（已有设计）

## 12. 待定问题

| 编号 | 问题 | 影响 | 建议 |
|------|------|------|------|
| OPEN-01 | mem CLI 是否提供 HTTP/长驻进程模式 | 若有，可进一步降低单次调用开销 | 评估后纳入后续迭代 |
| OPEN-02 | CLI 模式下 sync_relation 的异步任务是否需要等待 | 当前设计不等待，CLI 退出时向量可能丢失 | CLI 使用场景主要是 import，sync_relation 以 MCP 调用为主 |
