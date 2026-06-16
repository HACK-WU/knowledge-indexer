---
description: 指导 AI 管理知识索引和记忆。平台内置记忆用于简洁通用偏好，ki 记忆用于详细项目知识。强制加载 ki-foundation，按需选择 codekb-skill / memory-skill。
alwaysApply: true
enabled: true
updatedAt: 2026-06-13T17:10:00.000Z
provider:
---
# ai-codekb-memory AI 知识与记忆管理规则

> **对话开始时首先检查本规则**。

---

## 📋 已知 Scope 清单（请填写）

> 如果以下清单为空或已过期，Agent 会自动执行 `ki_manage_index_list` 获取最新列表。

```
# 请在此处列出项目当前的 scope（每行一个），例如：
# monitor          — BK-Monitor 代码知识库
# monitor-memory   — BK-Monitor 项目记忆
# user-profile     — 用户画像（全局固定）
```

---

## 记忆系统分工

| 系统 | 适用 | 典型内容 | 优势 |
|------|------|----------|------|
| **平台内置记忆** (`update_memory`) | 简洁、通用、跨项目、高频、稳定 | 沟通偏好、通用行为规则、工具习惯 | 自动注入上下文，零查询成本 |
| **ki 记忆** (`ki_sync_relation` / MCP) | 详细、项目特定、结构化、有时效 | 项目背景、架构决策、需求进度、代码知识 | Group 树组织、热区/语义检索、归档机制 |

**选择判断**：简洁+通用+跨项目 → 平台记忆；详细/项目特定/有时效/需结构化 → ki 记忆

ki 记忆内部：代码知识 → `codekb-skill`（`${scope}`）；项目上下文/偏好 → `memory-skill`（`${scope}-memory` / `user-profile`）

---

## 加载流程

| 步骤 | Skill | 触发条件 |
|------|-------|----------|
| ① | `ki-foundation` | **无条件加载**，对话开始即执行。不存在则提示安装并停止 |
| ②a | `codekb-skill` | 涉及代码/架构/API **详细**知识时 |
| ②b | `memory-skill` | 涉及项目背景/进度/偏好/用户记忆时 |

- ②a/②b 可按需选其一或并行，但必须在 ① 之后
- 当前会话已加载过的 skill 不重复加载；会话截断后视为未加载

---

## 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | **将详细项目知识存入平台内置记忆**（代码知识、架构决策等必须走 ki） |
| 🔴 2 | **将简洁通用偏好存入 ki**（沟通语言、通用规则等用平台记忆） |
| 🔴 3 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 4 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 5 | Skill 不存在时仍继续执行 ki 命令（应提示用户安装 knowledge-indexer） |
| 🔴 6 | **对 ki scope 使用 memory MCP 存取**（`user-profile`/`${scope}-memory`/`${scope}` 禁止 `memory_store`/`memory_recall`/`memory_update`/`memory_forget`，统一用 ki MCP 工具） |

> 例外：`codekb-skill` 的 `ki_search` 语义兜底不受规则6限制（ki MCP 内置向量工具）。平台内置记忆（`update_memory`）不写入 ki scope，也不受限。
