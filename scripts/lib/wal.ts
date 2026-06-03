/**
 * WAL 写入机制（Write-Ahead Log）
 * 
 * 写入流程：读内存 → 写 .tmp → atomic rename
 * 每次写入前自动备份原文件到 backup/ 目录（O6 决策）
 */

import fs from 'fs';
import path from 'path';

/**
 * WAL 写入：写临时文件 → 原子 rename
 * @param filePath 目标文件绝对路径
 * @param data 要写入的数据（会被 JSON.stringify）
 */
export function walWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tmpPath = path.join(dir, `${basename}.tmp`);

  // 确保目录存在
  fs.mkdirSync(dir, { recursive: true });

  // 写入前备份（O6 决策）
  if (fs.existsSync(filePath)) {
    backupBeforeWrite(filePath, dir);
  }

  // 写临时文件
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, jsonStr, 'utf-8');

  // 原子 rename
  fs.renameSync(tmpPath, filePath);
}

/**
 * 写入前备份原文件到 backup/ 目录
 * 备份格式：{filename}.{ISO8601}.bak.json
 */
function backupBeforeWrite(filePath: string, dir: string): void {
  const backupDir = path.join(dir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });

  const basename = path.basename(filePath, '.json');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${basename}.${timestamp}.bak.json`);

  fs.copyFileSync(filePath, backupPath);
}

/**
 * 清理目录中残留的 .tmp 文件
 * @param dir 要清理的目录
 * @returns 清理的文件数量
 */
export function cleanupTmpFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry.endsWith('.tmp')) {
      fs.unlinkSync(path.join(dir, entry));
      count++;
    }
  }
  return count;
}
