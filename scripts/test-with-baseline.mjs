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
import { isCoveredByBaseline, parseFailedCases } from './lib/vitest-output.mjs';

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
    // 2026-10-20 fix: 原为 300_000（5 分钟），但全量套件实测 314s~712s，
    // 会在中途杀进程并只拿到残缺输出，导致「新增失败」误报。
    timeout: 1_500_000,
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  output = (e.stdout || '') + (e.stderr || '');
  if (e.killed || e.signal) {
    console.error(`[baseline] ⚠ vitest 被终止（${e.signal ?? 'timeout'}），结果不完整`);
  }
}

// 解析 failed 用例。
//
// 2026-10-20 fix: 正则必须锚定行首。原本用 /\s*×\s+(.+?)\s+\d+ms/，
// 遇到 describe 名里自带 `×` 的用例（如 `pi bridge × runtime authorization (A2-T3)`）
// 会从那个 `×` 开始截，导致结果丢掉文件名与前缀、基线永远匹配不上。
//
// 2026-10-23 fix（审计 X-52，第四次复现把病灶钉在取材面）：
// vitest 输出**带 ANSI 转义码**，失败行实际形如
//   `\u001b[31m × \u001b[39m tests/a.test.ts > suite > case 123ms`
// 于是 `^\s*×` 永远不成立 —— 门上一条正则打在带 ANSI 的原面命中 0、
// 打在剥掉 ANSI 的面命中 1。后果是门永远报「本次 failed: 0 条」并 `exit 0`：
// 它区分不了「真的没有红」与「没看见任何红」。
//
// 修法：解析前先剥 ANSI。逻辑已抽到 scripts/lib/vitest-output.mjs（纯函数，可单测），
// 自检腿见 tests/test-with-baseline-parser.test.ts —— 门禁尺本身也要有守护。
const failed = parseFailedCases(output);

console.log(`[baseline] 本次 failed: ${failed.size} 条`);

// 找新增
const newFailed = [];
for (const f of failed) {
  // 匹配规则见 scripts/lib/vitest-output.mjs 的 isCoveredByBaseline：
  // 支持文件级与用例级条目、`::` 与 ` > ` 两种分隔符，并跳过 ::TODO 占位。
  if (!isCoveredByBaseline(f, baseline)) newFailed.push(f);
}

if (newFailed.length > 0) {
  console.error(`[baseline] 新增 ${newFailed.length} 个 failed（不在基线内）:`);
  for (const f of newFailed) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[baseline] 无新增 failed，通过');
process.exit(0);
