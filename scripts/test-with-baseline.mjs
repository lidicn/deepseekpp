#!/usr/bin/env node
/**
 * 测试基线对比脚本（P0-3）
 * 跑 vitest，收集 failed 用例，对比 tests/baseline-failed.txt。
 * 有新增 failed → exit 1；只有基线内的 failed → exit 0。
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const baselinePath = resolve(root, 'tests/baseline-failed.txt');

// 读基线
let baseline = new Set();
if (existsSync(baselinePath)) {
  const lines = readFileSync(baselinePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) baseline.add(trimmed);
  }
}

console.log(`[baseline] 已知 failed: ${baseline.size} 条`);

// 跑 vitest，收集输出
let output = '';
try {
  execSync('npx vitest run --reporter=verbose', {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 300000,
  });
} catch (e) {
  output = (e.stdout || '') + (e.stderr || '');
}

// 解析 failed 用例（格式：tests/xxx.test.ts > suite > test name）
const failed = new Set();
const lines = output.split('\n');
for (const line of lines) {
  const m = line.match(/\s*×\s+(.+?)\s+\d+ms/);
  if (m) {
    // 粗略匹配，只保留用例名
    failed.add(m[1].trim());
  }
}

console.log(`[baseline] 本次 failed: ${failed.size} 条`);

// 找新增
const newFailed = [];
for (const f of failed) {
  // 宽松匹配：用例名包含在基线里
  let known = false;
  for (const b of baseline) {
    if (b.endsWith(f) || f.includes(b.split('::').pop() || '')) {
      known = true;
      break;
    }
  }
  if (!known) newFailed.push(f);
}

if (newFailed.length > 0) {
  console.error(`[baseline] 新增 ${newFailed.length} 个 failed（不在基线内）:`);
  for (const f of newFailed) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[baseline] 无新增 failed，通过');
process.exit(0);
