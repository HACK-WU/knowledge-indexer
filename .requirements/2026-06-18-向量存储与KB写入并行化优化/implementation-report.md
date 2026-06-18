# 实现报告：向量存储与KB写入并行化优化

> 需求：REQ-20260618-001
> 状态：已完成
> 日期：2026-06-18

## 1. 实现摘要

| 子需求 | 描述 | 状态 | 变更文件 |
|--------|------|:---:|------|
| S-01 | sync_relation KB 写入后立即返回，向量异步执行 | ✅ | scripts/sync-relation.ts |
| S-02 | import Phase2 与 Phase3/4 并行执行 | ✅ | scripts/lib/import.ts |
| S-03 | 新 relation 不再写入 memoryId | ✅ | scripts/lib/import.ts |

## 2. 变更统计

```
 .requirements/config     |  35 ++--
 scripts/lib/import.ts    | 113 ++++++------
 scripts/sync-relation.ts |  49 +++---
 3 files changed, 121 insertions(+), 76 deletions(-)
```

## 3. 实现详情

### 3.1 S-01: sync_relation 异步向量化

**变更内容**：
- `executeSyncRelation()` 中的 `storeOnePath()` + `memStore()` 从同步阻塞改为 `Promise.resolve().then()` 异步执行
- 返回类型 `vectorStored?: boolean` → `vectorPending?: boolean`
- 新增注释说明 MCP server 长驻进程保证异步任务完成，CLI 模式下向量可能丢失为设计允许的降级

**预期效果**：MCP 调用延迟从 4-20s 降至 <200ms

### 3.2 S-02: import Phase 并行化

**变更内容**：
- `handleImport()` 中 Phase 2（向量化 + 路径向量写入）与 Phase 3/4（Group 树 + KB 写入）使用 `Promise.all` 并行执行
- 路径向量条目（pathEntries）和 group-index/relations-cache 预读取提前到并行段之前
- Phase 4 条目过滤逻辑从 `memoryMap.has(e.path)` 改为 `action !== 'delete'`（行为变更：向量化失败的条目现在也写入 relations-cache）

**预期效果**：import 总耗时减少 30-50%

### 3.3 S-03: memoryId 清理

**变更内容**：
- `upsertRelation()` 中删除 `if (memoryId) rel.memoryId = memoryId;` 行
- 保留 `if (sourcePath) rel.sourcePath = sourcePath;`
- 旧数据中的 memoryId 字段不删除（向后兼容）

**预期效果**：新 relation 不含 memoryId 死数据

## 4. 测试验证

| 测试文件 | 用例数 | 通过 | 失败 |
|----------|:---:|:---:|:---:|
| import-kb.test.ts | 7 | 7 | 0 |
| sync-relation.test.ts | 9 | 9 | 0 |
| lib.test.ts | 28 | 28 | 0 |
| integration.test.ts | 12 | 12 | 0 |
| scope-isolation.test.ts | 5 | 5 | 0 |
| **合计** | **61** | **61** | **0** |

## 5. 偏差记录

| 偏差项 | 设计预期 | 实际实现 | 原因 |
|--------|---------|---------|------|
| Phase 4 过滤逻辑 | 移除 memoryMap 依赖 | 改为 `action !== 'delete'` | 设计评审发现需显式处理此过滤逻辑，已在 §5.4 标注 |
| fireAndForget 位置 | 新增 `fireAndForgetVectorOps` 函数 | 内联在 `executeSyncRelation` 中 | 代码量小，无需独立函数，内联更简洁 |

## 6. 风险提醒

1. **CLI 模式向量丢失**：sync_relation CLI 模式下异步向量任务可能在进程退出前未完成 — 设计允许，sync_relation 主要通过 MCP 调用
2. **行为变更**：import 后向量化失败的条目现在也写入 relations-cache — 正确行为，两通道独立
