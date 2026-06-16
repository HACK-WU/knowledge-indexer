# S-05 `ki export` 导出为 Wiki 文档

> 状态：草案 | 依赖：S-01 | 被依赖：无

## 术语

| 术语 | 定义 |
|------|------|
| export | 将 KB scope 中的结构化数据反向导出为 Markdown 文件目录 |
| local KB | `kb/{scope}/{groupPath}/index.json`，存储每个 Group 下 Relation 的原文内容 |

## 现状（AS-IS）

KB 数据只能从外部 Wiki（Markdown）导入，无反向导出能力。用户无法将 KB 中的知识以文档形式交付。

## 方案（TO-BE）

### 新增 `scripts/export.ts`

读取 scope 内的本地数据（`group-index.json` + `relations-cache.json` + local KB `index.json`），将 Group 树重组为结构化 Markdown 文件目录。

**不依赖 mem CLI**：导出仅使用 scope 本地数据，不涉及向量库内容。

### 导出流程

1. 读取 `group-index.json` 获取 Group 树结构
2. 读取 `relations-cache.json` 获取每个 Group 下的 Relation 列表（含 keywords、memoryId 等元数据）
3. 遍历每个 Group，读取 local KB `kb/{scope}/{groupPath}/index.json` 获取 Relation 原文内容（`moduleInfo`）
4. 对每个 Relation 写入 `{output}/{groupPath}/{relation}.md`

### 输出结构

```
{output}/
  QoderWiki/
    核心概念/
      Scope 隔离机制.md
      Group 导航.md
    API/
      用户登录.md
```

### Markdown 文件格式

```markdown
---
groupPath: QoderWiki/核心概念
relation: Scope 隔离机制
keywords: [Scope, 隔离, 访问控制, ACL, agentId]
exportedAt: 2026-06-16T14:30:22.000Z
---

[local KB 中存储的 moduleInfo 原文内容]
```

### 数据来源说明

| 数据 | 来源文件 | 用途 |
|------|----------|------|
| Group 树结构 | `group-index.json` | 构建输出目录层级 |
| Relation 元数据 | `relations-cache.json` | keywords、memoryId 等 frontmatter |
| Relation 原文 | `kb/{scope}/{groupPath}/index.json` | Markdown 正文内容 |

### 无内容的 Relation

部分 Relation 在 local KB 中可能没有对应内容（如手动创建的 Group 节点），跳过正文写入，仅生成含 frontmatter 的空文件并在输出中记录。

## 接口设计

```typescript
// scripts/export.ts

interface ExportOptions {
  scope: string;
  output: string;        // 输出目录绝对路径
  rootName?: string;     // 可选：仅导出指定 rootName 下的内容
}

interface ExportResult {
  ok: boolean;
  action: 'export';
  scope: string;
  outputDir: string;
  stats: {
    total: number;       // 总 Relation 数
    exported: number;    // 成功导出数（含正文）
    empty: number;       // 无正文内容数（仅 frontmatter）
  };
  skipped: Array<{ groupPath: string; relation: string; reason: string }>;
}

/**
 * 导出 KB 为 Wiki Markdown（仅使用 scope 本地数据）
 */
export function handleExport(options: ExportOptions): ExportResult;
```

### CLI 接口

```bash
ki export <scope> --output <dir> [--root-name <name>]
```

输出：
```json
{
  "ok": true,
  "action": "export",
  "scope": "my-project",
  "outputDir": "/path/to/output",
  "stats": { "total": 15, "exported": 14, "empty": 1 },
  "skipped": []
}
```

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| scope 不存在 | throw Error | 是 |
| relations-cache.json 不存在 | throw Error + 提示先执行 import | 是 |
| 某个 Group 的 local KB index.json 不存在 | 该 Group 下 Relation 仅生成 frontmatter | 是：输出中包含 empty 计数 |
| 输出目录已存在且有内容 | 正常写入（覆盖同名文件） | 否 |
