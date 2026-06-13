## 备份与恢复

本文档说明 `knowledge-indexer` 的数据备份和恢复策略。

**备份策略**：二进制完整备份，直接复制 `kb/` 目录。

> 系统使用原子写入（tmp → rename）保证写入安全，不会因写入中断导致文件损坏。不再自动生成 backup 目录，由用户自行备份。

---

## 数据存储结构

### 核心数据目录

```
knowledge-indexer/
├── kb/                          # 运行时数据目录
│   ├── {scope}/                 # 每个 scope 独立目录
│   │   ├── group-index.json     # Group 树索引 + source 块
│   │   ├── relations-cache.json # Relation 缓存（评分/淘汰/词云）
│   │   ├── scan-index.json      # 扫描状态账本（可选）
│   │   └── {group}/             # 本地 KB 原文
│   │       └── index.json       # 模块说明原文
│   └── _template/               # 模板目录（初始化新 scope 用）
└── ...
```

### 关键文件说明

| 文件 | 作用 | 备份优先级 |
|------|------|-----------|
| `group-index.json` | Group 树结构索引 + source 块 | **必须** |
| `relations-cache.json` | Relation 缓存（含 memoryId） | **必须** |
| `scan-index.json` | 扫描状态账本 | 建议 |
| `{group}/index.json` | 本地 KB 原文 | 建议 |

---

## 备份策略

### 1. 完整备份（推荐）

**备份整个 `kb/` 目录**，包含所有 scope 的数据。

```bash
# 备份命令
rsync -av knowledge-indexer/kb/ /path/to/backup/kb/

# 或使用 tar 打包
tar -czf knowledge-indexer-backup-$(date +%Y%m%d_%H%M%S).tar.gz knowledge-indexer/kb/
```

**备份内容**：
- 所有 scope 的 `group-index.json`
- 所有 scope 的 `relations-cache.json`
- 所有 scope 的 `scan-index.json`
- 所有 scope 的本地 KB 原文

### 2. 单 scope 备份

**备份特定 scope 的数据**：

```bash
# 备份指定 scope
rsync -av knowledge-indexer/kb/{scope}/ /path/to/backup/{scope}/

# 或打包
tar -czf {scope}-backup-$(date +%Y%m%d_%H%M%S).tar.gz knowledge-indexer/kb/{scope}/
```

---

## 恢复策略

### 1. 完整恢复

**从完整备份恢复所有数据**：

```bash
# 恢复备份
rsync -av /path/to/backup/kb/ knowledge-indexer/kb/

# 或解压 tar 包
tar -xzf knowledge-indexer-backup-20260603_163600.tar.gz
```

### 2. 单 scope 恢复

**从单 scope 备份恢复**：

```bash
# 恢复指定 scope
rsync -av /path/to/backup/{scope}/ knowledge-indexer/kb/{scope}/

# 或解压
tar -xzf {scope}-backup-20260603_163600.tar.gz -C knowledge-indexer/kb/
```

### 3. 从模板重新初始化

当没有备份且数据损坏时，可删除 scope 目录后重新初始化：

```bash
# 备份现有数据（可选）
cp -r kb/{scope} kb/{scope}.bak.$(date +%Y%m%d%H%M%S)

# 删除损坏的 scope 目录
rm -rf kb/{scope}

# 触发自动初始化（运行任一 ki 命令即可）
ki manage-index --action list-scopes
ki sync-relation --scope {scope} --group "初始化" --relation "初始条目" --module-info "初始化" --keywords "初始化"

# 重新导入数据（如有原始 ai-results.json）
ki scan-kb import --scope {scope} --results ai-results.json
```

---

## 备份脚本示例

### 1. 完整备份脚本

```bash
#!/bin/bash
# backup-ki.sh - 完整备份 knowledge-indexer 数据

BACKUP_DIR="/path/to/backups"
KI_DIR="/path/to/knowledge-indexer"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="ki-backup-${TIMESTAMP}"

# 创建备份目录
mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}"

# 备份 kb/ 目录
rsync -av "${KI_DIR}/kb/" "${BACKUP_DIR}/${BACKUP_NAME}/kb/"

# 备份模板目录
rsync -av "${KI_DIR}/_template/" "${BACKUP_DIR}/${BACKUP_NAME}/_template/"

# 创建备份清单
cat > "${BACKUP_DIR}/${BACKUP_NAME}/manifest.txt" <<EOF
备份时间: $(date)
备份目录: ${KI_DIR}/kb/
备份内容: 所有 scope 数据
备份文件数: $(find "${BACKUP_DIR}/${BACKUP_NAME}" -type f | wc -l)
EOF

# 打包备份
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "${BACKUP_DIR}" "${BACKUP_NAME}"

# 清理临时目录
rm -rf "${BACKUP_DIR}/${BACKUP_NAME}"

echo "备份完成: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
```

### 2. 单 scope 备份脚本

```bash
#!/bin/bash
# backup-scope.sh - 备份指定 scope 的数据

SCOPE="$1"
BACKUP_DIR="/path/to/backups"
KI_DIR="/path/to/knowledge-indexer"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

if [ -z "$SCOPE" ]; then
  echo "用法: $0 <scope>"
  exit 1
fi

# 检查 scope 目录是否存在
if [ ! -d "${KI_DIR}/kb/${SCOPE}" ]; then
  echo "错误: scope '${SCOPE}' 不存在"
  exit 1
fi

# 创建备份
BACKUP_NAME="${SCOPE}-backup-${TIMESTAMP}"
mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}"

# 备份 scope 目录
rsync -av "${KI_DIR}/kb/${SCOPE}/" "${BACKUP_DIR}/${BACKUP_NAME}/"

# 打包
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "${BACKUP_DIR}" "${BACKUP_NAME}"
rm -rf "${BACKUP_DIR}/${BACKUP_NAME}"

echo "备份完成: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
```

### 3. 定时备份脚本

```bash
#!/bin/bash
# 定时备份脚本，可加入 crontab

# 示例 crontab 条目（每天凌晨 2 点备份）
# 0 2 * * * /path/to/backup-ki.sh

# 备份保留策略：保留最近 7 天的备份
BACKUP_DIR="/path/to/backups"
KEEP_DAYS=7

# 执行备份
/path/to/backup-ki.sh

# 清理旧备份
find "${BACKUP_DIR}" -name "ki-backup-*.tar.gz" -mtime +${KEEP_DAYS} -delete

echo "备份完成，保留最近 ${KEEP_DAYS} 天的备份"
```

---

## 恢复脚本示例

### 1. 完整恢复脚本

```bash
#!/bin/bash
# restore-ki.sh - 从完整备份恢复

BACKUP_FILE="$1"
KI_DIR="/path/to/knowledge-indexer"

if [ -z "$BACKUP_FILE" ]; then
  echo "用法: $0 <备份文件.tar.gz>"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "错误: 备份文件不存在"
  exit 1
fi

# 创建临时目录
TEMP_DIR=$(mktemp -d)

# 解压备份
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# 恢复 kb/ 目录
if [ -d "${TEMP_DIR}/kb" ]; then
  rsync -av "${TEMP_DIR}/kb/" "${KI_DIR}/kb/"
  echo "恢复 kb/ 目录完成"
fi

# 恢复模板目录
if [ -d "${TEMP_DIR}/_template" ]; then
  rsync -av "${TEMP_DIR}/_template/" "${KI_DIR}/_template/"
  echo "恢复 _template/ 目录完成"
fi

# 清理临时目录
rm -rf "$TEMP_DIR"

echo "恢复完成"
```

### 2. 单 scope 恢复脚本

```bash
#!/bin/bash
# restore-scope.sh - 恢复指定 scope 的数据

BACKUP_FILE="$1"
SCOPE="$2"
KI_DIR="/path/to/knowledge-indexer"

if [ -z "$BACKUP_FILE" ] || [ -z "$SCOPE" ]; then
  echo "用法: $0 <备份文件.tar.gz> <scope>"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "错误: 备份文件不存在"
  exit 1
fi

# 创建临时目录
TEMP_DIR=$(mktemp -d)

# 解压备份
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# 查找 scope 目录
SCOPE_DIR=$(find "$TEMP_DIR" -type d -name "$SCOPE" | head -1)

if [ -z "$SCOPE_DIR" ]; then
  echo "错误: 备份中未找到 scope '${SCOPE}'"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# 恢复 scope 目录
rsync -av "${SCOPE_DIR}/" "${KI_DIR}/kb/${SCOPE}/"

# 清理临时目录
rm -rf "$TEMP_DIR"

echo "恢复 scope '${SCOPE}' 完成"
```

---

## 故障恢复场景

### 场景 1：group-index.json 损坏

**症状**：读取 Group 树失败，报 JSON 解析错误

**恢复步骤**：
1. 从备份恢复：`rsync -av /path/to/backup/{scope}/group-index.json kb/{scope}/group-index.json`
2. 如无备份，删除 scope 目录后从模板重新初始化

### 场景 2：relations-cache.json 损坏

**症状**：Relation 查询失败，报 JSON 解析错误

**恢复步骤**：
1. 从备份恢复：`rsync -av /path/to/backup/{scope}/relations-cache.json kb/{scope}/relations-cache.json`
2. 如无备份，删除 scope 目录后从模板重新初始化

### 场景 3：整个 scope 数据丢失

**症状**：`kb/{scope}/` 目录不存在或为空

**恢复步骤**：
1. 从完整备份恢复整个 scope 目录
2. 或重新初始化 scope：`ki manage-index --scope {scope} --action create --name "初始化"`

### 场景 4：本地 KB 原文丢失

**症状**：`get-module-info` 返回空内容

**恢复步骤**：
1. 从备份恢复 `{group}/index.json` 文件
2. 或重新导入知识库：`ki scan-kb import --scope {scope} --results ai-results.json`

---

## 相关文档

- 架构说明：[`architecture.md`](./architecture.md)
- CLI 参考：[`cli.md`](./cli.md)
- 异常处理：[`error-handling.md`](./error-handling.md)
- 工作流：[`workflows.md`](./workflows.md)
