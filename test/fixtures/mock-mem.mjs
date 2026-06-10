#!/usr/bin/env node
// Mock mem CLI for S-03/S-04/S-06 tests.
// Behavior:
//   store <text> --scope <s> [--category <c>]                    → 输出 "Stored: ..." + "Memory ID: <hash>"
//   bulk-store -f <file> --json [--scope <s>]                    → 输出 JSON 结果
//   delete <id>                                                  → 输出 "Memory <id> forgotten."
// 用环境变量 MOCK_FAIL_PATHS（逗号分隔的 path 子串）触发 store 失败。
// 用环境变量 MOCK_BULK_FAIL_PATHS（逗号分隔的 text 子串）触发 bulk-store 单条失败。

import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'store') {
  const text = argv[1] || '';
  // 通过环境变量模拟失败
  const failPaths = (process.env.MOCK_FAIL_PATHS || '').split(',').filter(Boolean);
  if (failPaths.some((p) => text.includes(p))) {
    console.error('Mock store failure');
    process.exit(1);
  }
  // 通过环境变量模拟"没有 Memory ID 行"
  if (process.env.MOCK_NO_ID === '1') {
    console.log('Stored: "..." in scope \'mock\'');
    process.exit(0);
  }
  const id = crypto.randomBytes(8).toString('hex');
  console.log(`Stored: "${text.slice(0, 40)}..." in scope 'mock'`);
  console.log(`Memory ID: ${id}`);
  process.exit(0);
}

if (cmd === 'bulk-store') {
  // 解析 -f <file> --json [--scope <s>]
  let filePath = null;
  let isJson = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-f' && argv[i + 1]) {
      filePath = argv[++i];
    } else if (argv[i] === '--json') {
      isJson = true;
    } else if (argv[i] === '--scope') {
      i++; // skip scope value
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    console.error('bulk-store: missing or invalid -f file');
    process.exit(1);
  }

  const entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // 兼容 MOCK_FAIL_PATHS（与 store 命令共用）和 MOCK_BULK_FAIL_PATHS
  const failPaths = [
    ...(process.env.MOCK_FAIL_PATHS || '').split(',').filter(Boolean),
    ...(process.env.MOCK_BULK_FAIL_PATHS || '').split(',').filter(Boolean),
  ];

  const ok = [];
  const errors = [];
  const skipped = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = entry.text || '';
    if (!text.trim()) {
      skipped.push({ index: i, text, reason: 'empty text' });
      continue;
    }
    if (failPaths.some((p) => text.includes(p))) {
      errors.push({ index: i, text, error: 'Mock bulk-store failure' });
      continue;
    }
    ok.push({ index: i, text, id: crypto.randomBytes(8).toString('hex') });
  }

  const result = {
    total: entries.length,
    ok: ok.length,
    errors: errors.length,
    skipped: skipped.length,
    elapsedSeconds: 0.01,
    details: { ok, errors, skipped },
  };

  if (isJson) {
    console.log(JSON.stringify(result));
  } else {
    // human-readable
    console.log(`Processed ${entries.length} entries: ${ok.length} ok, ${errors.length} errors, ${skipped.length} skipped`);
  }
  // bulk-store 默认 exit 0（JSON 结果中记录 per-entry 错误）
  process.exit(0);
}

if (cmd === 'delete') {
  const id = argv[1];
  if (!id) {
    console.error('Missing id');
    process.exit(1);
  }
  if (process.env.MOCK_DELETE_FAIL === '1') {
    console.error('Mock delete failure');
    process.exit(1);
  }
  console.log(`Memory ${id} forgotten.`);
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(2);
