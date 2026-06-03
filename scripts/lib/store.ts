/**
 * JSON 存储层
 * 
 * - readJson: 读取 JSON + version 检查
 * - writeJson: WAL 写入
 * - initScope: 从 _template 初始化新 scope
 * - ensureScopeDir: 确保 kb/{scope}/ 目录存在
 */

import fs from 'fs';
import path from 'path';
import { walWrite } from './wal.js';
import { getKbDir, getGroupIndexPath, getRelationsCachePath, validateScope } from './scope.js';
import { CURRENT_DATA_VERSION, TEMPLATE_DIR } from './constants.js';

// ─── JSON 读写 ───

/**
 * 读取 JSON 文件，检查 version 兼容性
 * @returns 解析后的数据对象，文件不存在返回 null
 */
export function readJson<T = Record<string, unknown>>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  let data: T & { version?: number };
  try {
    data = JSON.parse(content) as T & { version?: number };
  } catch (parseErr) {
    const errDetail = parseErr instanceof SyntaxError ? parseErr.message : String(parseErr);
    const error = new Error(
      `JSON 文件损坏：${filePath}\n` +
      `解析错误：${errDetail}\n` +
      `建议：从备份恢复或从 _template/ 重新初始化此 scope`
    );
    (error as any).code = 'CORRUPT_JSON';
    throw error;
  }

  // version 检查：当前版本 1，旧版本数据做兼容处理
  if (data.version !== undefined && data.version > CURRENT_DATA_VERSION) {
    console.warn(
      `警告：文件 ${filePath} 版本 ${data.version} 高于当前支持版本 ${CURRENT_DATA_VERSION}，可能存在兼容性问题`
    );
  }

  return data;
}

/**
 * WAL 写入 JSON 文件
 * 自动添加 version 字段和 updatedAt 时间戳
 */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  const enriched = {
    ...data,
    version: data.version ?? CURRENT_DATA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  walWrite(filePath, enriched);
}

// ─── Scope 初始化 ───

/**
 * 确保 kb/{scope}/ 目录存在，不存在则从 _template 初始化
 */
export function ensureScopeDir(scope: string): void {
  validateScope(scope);
  const kbDir = getKbDir(scope);

  if (fs.existsSync(kbDir)) return;

  initScope(scope);
}

/**
 * 从 _template/ 初始化新 scope
 * 复制 group-index.json 和 relations-cache.json，替换 scope 字段
 */
export function initScope(scope: string): void {
  validateScope(scope);
  const kbDir = getKbDir(scope);

  // 创建目录
  fs.mkdirSync(kbDir, { recursive: true });

  // 复制 group-index.json
  const templateGroupIndex = path.join(TEMPLATE_DIR, 'group-index.json');
  const targetGroupIndex = getGroupIndexPath(scope);
  if (fs.existsSync(templateGroupIndex)) {
    const data = JSON.parse(fs.readFileSync(templateGroupIndex, 'utf-8'));
    data.scope = scope;
    data.updatedAt = new Date().toISOString();
    walWrite(targetGroupIndex, data);
  }

  // 复制 relations-cache.json
  const templateRelationsCache = path.join(TEMPLATE_DIR, 'relations-cache.json');
  const targetRelationsCache = getRelationsCachePath(scope);
  if (fs.existsSync(templateRelationsCache)) {
    const data = JSON.parse(fs.readFileSync(templateRelationsCache, 'utf-8'));
    data.scope = scope;
    data.updatedAt = new Date().toISOString();
    walWrite(targetRelationsCache, data);
  }
}
