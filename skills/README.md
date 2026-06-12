# 知识索引 Skills

> Agent 行为规则与操作指南，按需加载。

## Skills 列表

| Skill | 场景 | 核心能力 |
|-------|------|---------|
| **ki-foundation** | 前置知识（必读） | ki 架构心智模型 + 命令参考 |
| **codekb-skill** | 代码知识库检索/写入 | 四步走查询 + 白名单/黑名单 |
| **memory-skill** | 项目记忆/用户画像读写 | 归档机制 + 自动沉淀 + Group 结构 |

## 使用方式

Agent 加载顺序：

```
1. ki-foundation.md          → 先建立 ki 心智模型
2. codekb-skill.md / memory-skill.md → 按场景加载行为规则
```

```
涉及代码知识 → 加载 codekb-skill
涉及项目记忆/用户偏好 → 加载 memory-skill
```

## 操作指南文档

| 文档 | 场景 |
|------|------|
| `docs/build-kb.md` | 首次构建知识索引（S-04 统一 2 步导入流程） |
| `docs/update-kb.md` | 增量更新知识索引（diff 检测 → 3 步增量） |
| `docs/query-kb.md` | 知识库查询（快速路径 + 检索路径 + 缺失路径） |
| `docs/manage-index.md` | 索引结构管理（Group/Relation CRUD） |
| `docs/verify-index.md` | 验证操作结果（结构/内容/检索验证） |
| `docs/restore-data.md` | 数据恢复 / 重新初始化 |

## 三层架构基础

所有 skill 共享的三层文件系统：

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Group 树索引 (group-index.json)          │
│  - 层级导航：项目根 → 子Group → ...                 │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Relations 缓存 (relations-cache.json)    │
│  - 热门 Relation 列表 + 评分 + 冷热分区             │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: 本地 KB (index.json)                     │
│  - Markdown 模块信息全文                            │
└─────────────────────────────────────────────────────┘
```

## MCP 工具配合

所有 skill 需要配合父项目的 MCP 工具：

| MCP 工具 | 使用场景 |
|---------|---------|
| `memory_recall` | 检索路径：语义检索 |
| `memory_store` | 向量化摘要 |
| `memory_forget` | 删除记忆 |

## 相关文档

- 设计文档：`docs/`（S-01~S-06）
- 操作指南：`docs/{build,update,query,manage,verify,restore}-*.md`
- 脚本目录：`scripts/`
- 测试覆盖：`test/`
- 知识索引总览：`README.md`
- scan-kb 子命令详解：`docs/scan-kb.md`
- 备份与恢复：`docs/backup-restore.md`
