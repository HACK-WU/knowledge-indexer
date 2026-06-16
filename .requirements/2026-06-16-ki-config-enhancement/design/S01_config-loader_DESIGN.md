# S-01 配置文件加载机制

> 状态：草案 | 依赖：无 | 被依赖：S-02, S-03, S-04, S-05

## 术语

| 术语 | 定义 |
|------|------|
| KiConfig | 配置文件解析后的类型化对象 |
| configPath | 配置文件的绝对路径 |
| dataDir | KB 数据根目录（全局默认） |
| backupDir | 备份数据根目录 |
| pathExpansion | 将 `$HOME`、`~`、相对路径转换为绝对路径的过程 |

## 现状（AS-IS）

数据目录由 `scripts/lib/constants.ts` 中 `KB_BASE_DIR` 决定：

```typescript
// constants.ts L64-70
export const KB_BASE_DIR = (() => {
  const envDir = process.env.KI_DATA_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  return path.join(KI_ROOT, 'kb');
})();
```

`scope.ts` 中 `getKbDir()` 硬编码 `path.join(KB_BASE_DIR, scope)`，无 scope 级路径覆盖能力。

环境变量 `KI_DATA_DIR` 不可见、不可审计、团队协作时无法随项目提交。

## 方案（TO-BE）

### 配置加载模型（#1 修复）

**单次加载、进程内缓存**：`loadConfig()` 使用模块级变量缓存，整个进程生命周期内只读取一次配置文件。

```typescript
// scripts/lib/config.ts
// 【打破循环依赖】config.ts 自行计算 KI_ROOT，不 import constants.ts
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KI_ROOT = path.resolve(__dirname, '..', '..');

let _cached: KiConfig | null = null;

export function loadConfig(explicitPath?: string): KiConfig {
  if (_cached) return _cached;
  const configPath = explicitPath ?? process.env.KI_CONFIG_PATH ?? undefined;
  const file = findConfigFile(configPath);
  _cached = file ? parseAndExpand(file) : buildDefaults();
  return _cached;
}

/** 测试/特殊场景下清除缓存 */
export function resetConfigCache(): void { _cached = null; }
```

**循环依赖解决方案**：`config.ts` 自行计算 `KI_ROOT`（与 `constants.ts` 相同的算法），不 import `constants.ts`，打破 `config.ts → constants.ts → config.ts` 环。

**传递链路**：
- `ki.mjs` 解析 `--config <path>`，通过环境变量 `KI_CONFIG_PATH` 传递给子进程
- 子进程（各 `scripts/*.ts`）首次调用 `loadConfig()` 时从 `KI_CONFIG_PATH` 读取路径
- 后续调用命中缓存，无 I/O 开销

### 改造 `constants.ts`（#4 修复）

移除 `KI_DATA_DIR` 环境变量读取。`KB_BASE_DIR` 改为**延迟初始化**（首次调用时从 `loadConfig()` 获取并缓存），配置在进程生命周期内不变：

```typescript
// constants.ts
let _baseDir: string | null = null;

export function getKbBaseDir(): string {
  if (_baseDir === null) {
    _baseDir = loadConfig().dataDir;
  }
  return _baseDir;
}
```

选择延迟初始化而非 getter 的理由：配置在进程内不变，getter 每次调用重新计算无意义。

### 改造 `scope.ts` — 完整改造清单

`KB_BASE_DIR` 从常量改为 `getKbBaseDir()` 函数后，`scope.ts` 中所有直接引用 `KB_BASE_DIR` 的地方都需要改造：

| 函数 | 当前引用 | 改造后 |
|------|----------|--------|
| `getKbDir(scope)` | `path.join(KB_BASE_DIR, scope)` | 调用 `loadConfig()` → 检查 `config.scopes[scope].kbDir`，有则使用，无则 fallback 到 `config.dataDir + '/' + scope` |
| `getLocalKbDir(scope, groupPath)` | `path.join(KB_BASE_DIR, scope, groupPath, 'index.json')` | 改为 `path.join(getKbDir(scope), groupPath, 'index.json')`，复用 `getKbDir` |
| `listAllScopes()` | `readdirSync(KB_BASE_DIR)` | 合并扫描 `loadConfig().dataDir` 下的目录 **∪** `config.scopes` 中配置的 scope 名称 |

**`listAllScopes()` 改造细节**：

```typescript
export function listAllScopes(): string[] {
  const config = loadConfig();
  const scopeSet = new Set<string>();

  // 1. 扫描 dataDir 下的目录（现有逻辑）
  if (fs.existsSync(config.dataDir)) {
    const entries = fs.readdirSync(config.dataDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(e.name)) {
        const scopeDir = path.join(config.dataDir, e.name);
        if (fs.existsSync(path.join(scopeDir, 'relations-cache.json'))) {
          scopeSet.add(e.name);
        }
      }
    }
  }

  // 2. 合并 config.scopes 中配置的自定义 kbDir 的 scope
  for (const [name, sc] of Object.entries(config.scopes)) {
    if (sc.kbDir && fs.existsSync(path.join(sc.kbDir, 'relations-cache.json'))) {
      scopeSet.add(name);
    }
  }

  return [...scopeSet];
}
```

### 改造 `ki.mjs` — argv 预解析 + 全局参数

`ki.mjs` 是扁平命令映射（`args[0]` = 命令名），不支持全局参数。需在命令查找前**预解析** `--config`：

```javascript
// ki.mjs argv 预解析
const args = process.argv.slice(2);

// 提取全局 --config 参数（可在任意位置）
let configPath = null;
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && i + 1 < args.length) {
    configPath = args[++i]; // 跳过 --config 的值
  } else {
    filteredArgs.push(args[i]);
  }
}

const command = filteredArgs[0];
const scriptArgs = filteredArgs.slice(1);

// 传递 KI_CONFIG_PATH 给子进程
const childEnv = { ...process.env, KI_ORIGINAL_CWD: process.cwd() };
if (configPath) {
  childEnv.KI_CONFIG_PATH = path.resolve(configPath);
}

execFileSync('npx', ['jiti', scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  cwd: PROJECT_ROOT,
  env: childEnv,
});
```

这样无论 `--config` 出现在 `ki` 命令的哪个位置，都能被正确提取和传递。

### 配置文件查找链

```typescript
function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) return path.resolve(explicitPath);
  
  // 【cwd 修复】使用 KI_ORIGINAL_CWD（ki.mjs 传递的用户工作目录）
  // 而非 process.cwd()（ki.mjs 子进程的 cwd 是 PROJECT_ROOT）
  const userCwd = process.env.KI_ORIGINAL_CWD || process.cwd();
  
  const candidates = [
    path.join(userCwd, '.ki', 'config.json'),
    path.join(os.homedir(), '.ki', 'config.json'),
  ];
  
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
```

**cwd 修复说明**：`ki.mjs` 通过 `execFileSync` 启动子进程时 `cwd: PROJECT_ROOT`，导致 `process.cwd()` 返回项目根目录而非用户工作目录。已有 `KI_ORIGINAL_CWD` 环境变量传递用户原始 cwd，`findConfigFile` 应优先使用该值。

无配置文件时：使用内置默认值 `{ dataDir: path.join(KI_ROOT, 'kb'), backupDir: path.join(KI_ROOT, 'ki-backup'), scopes: {} }`。

### 路径展开

```typescript
function expandPath(input: string, baseDir: string): string {
  let result = input;
  const home = os.homedir();
  result = result.replace(/^\$HOME/, home);
  result = result.replace(/^~/, home);
  if (!path.isAbsolute(result)) {
    result = path.resolve(baseDir, result);
  }
  return result;
}
```

`baseDir` = 配置文件所在目录（若 `--config` 指定）或 `KI_ORIGINAL_CWD`（用户工作目录）。

## 接口设计

```typescript
// scripts/lib/config.ts

export interface ScopeConfig {
  kbDir?: string;
  sourceDir?: string;
  rootName?: string;
}

export interface KiConfig {
  dataDir: string;       // 展开后的绝对路径
  backupDir: string;     // 展开后的绝对路径
  scopes: Record<string, ScopeConfig>;
  _configPath?: string;  // 调试用：实际加载的配置文件路径
}

/**
 * 加载配置文件
 * @param explicitPath --config 指定的路径
 * @returns 解析后的配置对象（所有路径已展开为绝对路径）
 */
export function loadConfig(explicitPath?: string): KiConfig;

/**
 * 获取指定 scope 的数据目录
 * 优先使用 scope 级 kbDir，fallback 到全局 dataDir/{scope}
 */
export function getScopeDataDir(config: KiConfig, scope: string): string;

/**
 * 获取备份根目录（#2 修复：补齐此函数）
 */
export function getBackupDir(config: KiConfig): string;

/**
 * 获取指定 scope 的 sourceDir（如果配置了）
 */
export function getScopeSourceDir(config: KiConfig, scope: string): string | null;

/**
 * 获取指定 scope 的 rootName（如果配置了）
 */
export function getScopeRootName(config: KiConfig, scope: string): string | null;

/** 测试用：清除进程内缓存 */
export function resetConfigCache(): void;
```

## 数据模型

配置文件 JSON Schema：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `dataDir` | string | 否 | `{KI_ROOT}/kb` | KB 数据根目录 |
| `backupDir` | string | 否 | `{KI_ROOT}/ki-backup` | 备份数据根目录 |
| `scopes` | object | 否 | `{}` | scope 级配置 |
| `scopes.{name}.kbDir` | string | 否 | `{dataDir}/{name}` | 自定义存储路径 |
| `scopes.{name}.sourceDir` | string | 否 | — | 外部知识库目录 |
| `scopes.{name}.rootName` | string | 否 | — | 根节点名称 |

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| `--config` 指定路径不存在 | throw Error + 提示检查路径 | 是：stderr 输出错误 |
| 配置文件 JSON 解析失败 | throw Error + 提示行号/字符 | 是：stderr 输出 |
| `$HOME` 环境变量不存在 | fallback 到 `os.homedir()` | 否：静默处理 |
| 路径展开后目录不存在 | 不报错（目录在首次使用时按需创建） | 否 |
| 无配置文件 | 使用内置默认值 + stderr 输出一行迁移提示：`提示：未找到配置文件，使用默认路径。执行 ki config init 创建配置文件` | 是：stderr 提示（不阻断运行） |

## 迁移策略

`KI_DATA_DIR` 环境变量移除后，存量用户首次运行：
- 无配置文件 → 使用内置默认值（`{KI_ROOT}/kb`）
- 如原数据在 `KI_DATA_DIR` 指向的目录 → 用户需手动创建配置文件指定 `dataDir`
- 建议：`ki config init` 时检测旧 `KI_DATA_DIR`，自动填入配置文件
