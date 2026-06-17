# Group 树结构

Group 是 ki 的知识分类单元，以树形结构组织，存储在 group-index.json 中。

## 数据格式（v2）

```json
{
  "version": 2,
  "scope": "myproject",
  "groups": {
    "API": {
      "用户认证": {},
      "数据查询": {}
    },
    "部署指南": {}
  }
}
```

## 路径表示

- 顶层 Group：`API`
- 子 Group：`API/用户认证`
- 深层 Group：`API/用户认证/OAuth`

## source 块

group-index.json 中的 source 记录导入来源：

```json
{
  "source": {
    "dir": "/path/to/wiki",
    "rootName": "TestWiki",
    "commit": "abc123..."
  }
}
```

增量 diff 基于 source.commit 与 HEAD 的差异。
