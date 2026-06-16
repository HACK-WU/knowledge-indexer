# S-02 `ki config init` 初始化命令

> 状态：草案 | 依赖：S-01 | 被依赖：无

## 术语

| 术语 | 定义 |
|------|------|
| config template | `ki config init` 生成的配置文件模板内容 |

## 现状（AS-IS）

无配置文件初始化能力。用户需手动创建 `.ki/config.json`，无模板参考。

## 方案（TO-BE）

新增 `ki config init` 子命令，在指定目录生成配置文件模板。

### 新增 `scripts/config.ts`

注册为 `ki config` 子命令，支持 `init` action。

### 生成位置

默认在当前工作目录 `.ki/config.json`，可通过 `--dir <path>` 指定。

### 模板内容

模板生成时**自动探测现有数据目录**，避免用户执行 init 后数据“消失”：

```typescript
function buildConfigTemplate(): object {
  // 探测顺序：
  // 1. KI_DATA_DIR 环境变量（存量用户迁移）
  // 2. {KI_ROOT}/kb 目录是否存在
  // 3. 默认值 $HOME/.ki-data
  let dataDir = '$HOME/.ki-data'; // 默认
  
  if (process.env.KI_DATA_DIR) {
    dataDir = process.env.KI_DATA_DIR; // 存量用户：自动填入旧值
  } else {
    const defaultKb = path.join(KI_ROOT, 'kb');
    if (fs.existsSync(defaultKb) && fs.readdirSync(defaultKb).length > 0) {
      dataDir = defaultKb; // 已有数据：填入实际路径
    }
  }
  
  return {
    dataDir,
    backupDir: '$HOME/.ki-backup',
    scopes: {}
  };
}
```

这样生成的模板中的 `dataDir` 与用户现有数据目录保持一致，不会导致数据“消失”。

### 幂等性

如果目标文件已存在，输出提示并退出，不覆盖。可通过 `--force` 强制覆盖。

## 接口设计

```typescript
// scripts/config.ts

// CLI 参数
// ki config init [--dir <path>] [--force]

interface ConfigInitOptions {
  dir?: string;    // 目标目录，默认 process.cwd()
  force?: boolean; // 强制覆盖已有文件
}

function handleConfigInit(options: ConfigInitOptions): {
  ok: boolean;
  action: 'config_init';
  configPath: string;
  existed: boolean;
};
```

### 子命令注册（#7 修复）

`config` 在 `ki.mjs` 中注册为单一命令，内部通过 commander 子命令解析 `init`：

```typescript
// scripts/config.ts
import { Command } from 'commander';

const program = new Command();
program.name('config').description('ki 配置管理');

program
  .command('init')
  .description('生成配置文件模板')
  .option('--dir <path>', '目标目录，默认当前目录')
  .option('--force', '强制覆盖已有文件')
  .action((opts) => handleConfigInit(opts));

// 未匹配子命令时输出帮助
program.action(() => { program.outputHelp(); });

program.parse();
```

`ki.mjs` 命令映射：

```javascript
'config': 'scripts/config.ts'
```

调用方式：`ki config init`、`ki config`（输出帮助）

### 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| `.ki/config.json` 已存在且无 `--force` | 输出提示 + exit(0) | 是：stdout 提示已存在 |
| 目标目录不可写 | throw Error | 是：stderr 输出 |
| `--dir` 路径不存在 | 自动创建目录 | 否 |
