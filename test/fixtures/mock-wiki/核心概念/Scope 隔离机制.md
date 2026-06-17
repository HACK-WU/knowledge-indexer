# Scope 隔离机制

ki 使用 scope 实现多项目隔离，每个 scope 拥有独立的数据目录。

## 核心设计

- scope 仅允许字母、数字、连字符、下划线
- 数据存储在 `kb/{scope}/` 下，包含 group-index.json、relations-cache.json
- 环境变量 `KI_CONFIG_PATH` 可指定自定义配置文件路径

## 多项目场景

```bash
# 项目 A
ki query-group --scope project-a --group "API"

# 项目 B（互不干扰）
ki query-group --scope project-b --group "API"
```

## 配置优先级

1. `--config` 参数（命令行指定）
2. `$HOME/.ki/config.json`（用户级默认）
3. 内置默认值
