#!/usr/bin/env node
// Mock mem CLI for S-03 batchVectorize tests.
// Behavior:
//   store <text> --scope <s> [--category <c>]  → 输出 "Stored: ..." + "Memory ID: <hash>"
//   delete <id>                                 → 输出 "Memory <id> forgotten."
// 用环境变量 MOCK_FAIL_PATHS（逗号分隔的 path 子串）触发失败。

import process from 'node:process';
import crypto from 'node:crypto';

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
