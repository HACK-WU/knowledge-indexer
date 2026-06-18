---
id: REQ-20260618-001
feature: 向量存储与KB写入并行化优化
status: 已确认
created: 2026-06-18
updated: 2026-06-18
version: 1
tags: [refactor, performance]
depends_on: []
author: AI
document_type: requirement
---

# 需求挖掘报告：向量存储与KB写入并行化优化

## 1. 原始需求描述

> 当前 ki 的 sync_relation 工具延迟有点高。看看怎么可以优化一下。

## 2. 需求澄清

### 2.1 需求形态
真实需求 — `sync_relation` 和 `scan-kb import` 的端到端延迟高，根因是向量存储（`mem` CLI）同步阻塞了核心 KB 写入流程。

### 2.2 功能本质
将两条互不依赖的数据通道（向量通道 vs KB 通道）解耦执行：`sync_relation` 场景异步化向量写入，`import` 场景并行化两个通道。

### 2.3 使用场景与角色

- **场景 1**：AI Agent 通过 MCP 调用 `ki_sync_relation` 写入单条关系。当前每次需等待 4-20s（两次 `mem store` 串行阻塞），期望 KB 写入完成后立即返回。
- **场景 2**：`scan-kb import` 批量导入。当前 Phase 2（向量化）完成后才执行 Phase 3/4（Group 树 + KB 写入），期望两者并行执行，均完成后返回。
- **场景关联性**：共享同一向量通道（`mem` CLI），但各自独立调用。

### 2.4 用户角色
AI Agent（MCP 调用者）及间接体验的人类用户。

### 2.5 核心痛点
- `sync_relation`：两条独立的 `mem store` 调用串行执行，总延迟 4-20s，但核心写入（缓存 + 本地KB）仅需 <30ms
- `scan-kb import`：Phase 2 向量化等待完成后，才执行 Phase 3/4（Group 树构建 + KB 写入），浪费并行机会

### 2.6 期望体验
- `sync_relation`：MCP 调用 <200ms 返回，向量存储后台完成
- `scan-kb import`：KB 写入与向量化并行，总耗时减少 30-50%

### 2.7 深层动机
ki 的双记忆系统（本地 KB + 向量索引）设计上是两条独立数据通道，但实现时被串行化了。这是历史实现遗留，不是架构设计的必然结果。

### 2.8 非功能性需求
- **性能**：`sync_relation` MCP 调用延迟 <200ms；`import` 总耗时减少 30-50%
- **兼容性**：旧的 `memoryId` 字段保留不删除，新 relation 不再写入 `memoryId`
- **数据一致性**：向量写入异步失败不影响 KB 数据完整性

## 3. 根本性分析

### 3.1 核心问题
向量存储（外部 `mem` CLI 进程）的同步执行阻塞了与之无依赖关系的 KB 写入流程。

### 3.2 根因链
1. `mem` CLI 是外部进程，每次调用需进程启动 + 向量嵌入 + 存储（2-10s）
2. 代码使用 `execFileSync` 同步调用，阻塞主线程
3. 两条向量写入（ki-relation + ki-search）串行执行
4. 向量通道与 KB 通道虽互不依赖，但代码将它们串行编排

### 3.3 方案评估
**判定：情况 A — 对症**

| 通道 | 内容 | 消费方 | 依赖 |
|------|------|--------|------|
| KB 通道 | relations-cache + local KB + wiki | `query-group`、`get-module-info` | 无 |
| 向量通道 | `mem store` (ki-relation + ki-search) | `search`（语义检索） | 无 |

两通道互不依赖，可并行或异步执行。

### 3.4 预期效果
- **核心场景覆盖度**：高 — 覆盖 sync_relation 单条写入 + import 批量导入两种场景
- **痛点解决程度**：高 — sync_relation 延迟降 95%+，import 总耗时降 30-50%
- **用户体验提升**：AI Agent 调用 sync_relation 不再阻塞推理流程
- **潜在副作用**：向量写入变为异步后，调用方无法在返回时确认向量是否成功（原有设计就已 try-catch 容错）

### 3.5 建议
- **sync_relation**：KB 写入完成后立即返回，向量存储后台异步执行（fire-and-forget）
- **scan-kb import**：Phase 2 与 Phase 3/4 并行执行（`Promise.all`），均完成后统一返回
- **memoryId 清理**：旧数据保留兼容，新 relation 不再写入 `memoryId` 字段

## 4. 需求清单

### 4.1 需求拆分

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|--------|---------|----------|----------|------|----------|
| P0 | REQ-01 | `sync_relation` KB 写入完成后立即返回，向量存储后台异步执行 | 单次调用 4-20s → <200ms | - | MCP 调用返回 <200ms；向量最终一致性写入 |
| P0 | REQ-02 | `scan-kb import` Phase2（向量化）与 Phase3/4（Group树+KB）并行执行 | import 总耗时减少 30-50% | - | KB 数据完整；向量化结果正确；总耗时 < max(Phase2, Phase3/4) |
| P1 | REQ-03 | relations-cache 新增 relation 不再写入 `memoryId`，旧数据保留兼容 | 数据结构更清晰 | REQ-02 | 新 relation 无 `memoryId` 字段；旧数据可正常读取 |

### 4.2 需求依赖图

```
REQ-01 (sync_relation 异步化)     REQ-02 (import 并行化)
    │                                   │
    └── REQ-03 (清理 memoryId)──────────┘
```

### 4.3 需求验证标准

| 需求 ID | 验证方式 | 验证指标 | 验证时机 |
|---------|----------|----------|----------|
| REQ-01 | MCP 调用计时 | 返回时间 <200ms | 开发完成后 |
| REQ-01 | 查询验证 | `ki search` 语义检索能命中异步写入的向量 | 开发完成后 |
| REQ-02 | 导入计时 | 100 条 import 总耗时减少 30%+ | 开发完成后 |
| REQ-02 | 数据完整性 | import 后 `query-group` + `ki search` 均正常 | 开发完成后 |
| REQ-03 | 字段检查 | 新 relation 无 `memoryId` 字段 | 开发完成后 |

### 4.4 成功度量指标

| 度量维度 | 指标名称 | 当前基线 | 目标值 | 度量方式 |
|----------|----------|----------|--------|----------|
| 性能 | sync_relation MCP 延迟 | 4-20s | <200ms | 计时 |
| 性能 | import 100条总耗时 | ~120s | <80s | 计时 |
| 数据质量 | relations-cache 无用字段 | 含 memoryId | 不含 memoryId | JSON 字段检查 |

## 5. 潜在风险与注意事项

1. **向量异步写入丢失风险**：MCP server 短命进程可能在向量写入完成前退出。需确保异步任务在进程退出前完成（`await` 队列排空或使用 `process.on('beforeExit')`）。
2. **import 并行化内存开销**：Phase 2 和 Phase 3/4 并行时，两份数据结构同时驻留内存，大数据集需关注内存使用。
3. **旧 memoryId 兼容**：不删除旧数据的 `memoryId` 字段，增量导入的 delete/modify 流程不受影响（它们用的是 `scan-index.json` 的 memoryId）。

## 6. 迭代建议

- **第一阶段**：实现 REQ-01 + REQ-02（核心性能优化）
- **第二阶段**：实现 REQ-03（数据结构清理）
- **长期**：评估是否将 `mem` CLI 调用改为 HTTP 长驻进程模式，进一步降低进程启动开销
