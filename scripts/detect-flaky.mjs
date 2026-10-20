#!/usr/bin/env node
/**
 * T35 flaky 侦测脚本（纯本地，不阻塞 CI）。
 *
 * 连跑 N 次 vitest，取每轮失败的测试文件集合，做差集：
 *   - 每轮都失败  → 稳定红（不是 flaky，需修或进基线白名单）
 *   - 出现过但非每轮 → 抖动（flaky，需排查时序/单例污染）
 *   - 从未失败    → 稳定绿
 *
 * 用法：
 *   node scripts/detect-flaky.mjs --only sidepanel --runs 2
 *   node scripts/detect-flaky.mjs --runs 3            # 全量
 *
 * 说明：--only 作为 vitest 的位置过滤子串透传；--runs 默认 2。
 * json reporter 解析失败时降级为单轮文本扫描，并标注「多轮对比待补」。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ---- 参数解析 ----
function parseArgs(argv) {
  const args = { only: null, runs: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only') {
      args.only = argv[++i];
    } else if (a === '--runs') {
      args.runs = Math.max(1, Number.parseInt(argv[++i] ?? '2', 10) || 2);
    } else if (a.startsWith('--only=')) {
      args.only = a.slice('--only='.length);
    } else if (a.startsWith('--runs=')) {
      args.runs = Math.max(1, Number.parseInt(a.split('=').at(-1), 10) || 2);
    }
  }
  return args;
}

/** 归一化为相对 root 的 posix 路径，便于跨轮对比。 */
function normalizeFile(absPath) {
  const rel = relative(root, absPath).split(sep).join('/');
  return rel.startsWith('tests/') || rel.startsWith('src/') ? rel : `tests/${rel}`;
}

/** 从一轮 vitest json 结果提取失败文件集合。 */
function failedFilesFromJson(json) {
  const set = new Set();
  const results = json?.testResults ?? [];
  for (const tr of results) {
    const hasFailed = (tr.assertionResults ?? []).some((a) => a.status === 'failed');
    if (hasFailed) set.add(normalizeFile(tr.name));
  }
  return set;
}

/** 跑一轮，落 json 到临时文件，返回失败文件集合；解析失败返回 null。 */
function runOnce(runIndex, only) {
  const dir = mkdtempSync(join(tmpdir(), 'dpp-flaky-'));
  const outFile = join(dir, `run-${runIndex}.json`);
  // Windows 下 npx 是 npx.cmd，必须走 shell（execSync 字符串），execFileSync 不带 shell 解析不到。
  const filter = only ? ` ${JSON.stringify(only)}` : '';
  const cmd = `npx vitest run --reporter=json "--outputFile=${outFile}"${filter}`;

  try {
    // vitest 有失败用例时退出码非 0，不视为致命错误，由 json 判定。
    execSync(cmd, { cwd: root, encoding: 'utf8', timeout: 300_000, stdio: 'ignore' });
  } catch {
    // 忽略非零退出，继续读 json。
  }

  if (!existsSync(outFile)) return null;
  try {
    const json = JSON.parse(readFileSync(outFile, 'utf8'));
    return failedFilesFromJson(json);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 降级：单轮文本扫描失败用例（× 行），不做多轮差集。 */
function fallbackTextScan(only) {
  let output = '';
  const filter = only ? ` ${JSON.stringify(only)}` : '';
  const cmd = `npx vitest run --reporter=verbose${filter}`;
  try {
    execSync(cmd, { cwd: root, encoding: 'utf8', timeout: 300_000, stdio: 'pipe' });
  } catch (e) {
    output = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const failed = new Set();
  for (const line of output.split('\n')) {
    const m = line.match(/\s*×\s+(tests\/[^\s>]+\.test\.ts)[\s>]/);
    if (m) failed.add(m[1]);
  }
  return failed;
}

function main() {
  const { only, runs } = parseArgs(process.argv);
  console.log(`[flaky] runs=${runs}${only ? ` only=${only}` : ''}`);

  const rounds = [];
  let degraded = false;
  for (let i = 1; i <= runs; i += 1) {
    const failed = runOnce(i, only);
    if (failed === null) {
      degraded = true;
      break;
    }
    rounds.push(failed);
    console.log(`[flaky] 轮次 ${i}/${runs}：失败 ${failed.size} 个文件`);
  }

  // ---- 降级：json 解析不出，单轮文本扫描 ----
  if (degraded || rounds.length === 0) {
    console.warn('[flaky] ⚠ json 结果解析失败，降级为单轮文本扫描（多轮对比待补）');
    const failed = fallbackTextScan(only);
    console.log('\n=== 单轮失败文件（多轮对比待补）===');
    if (failed.size === 0) console.log('  （无失败）');
    for (const f of [...failed].sort()) console.log(`  - ${f}`);
    process.exit(0);
  }

  // ---- 差集：稳定红（每轮都失败）/ 抖动（部分轮次）----
  const tally = new Map();
  for (const set of rounds) {
    for (const f of set) tally.set(f, (tally.get(f) ?? 0) + 1);
  }
  const stableRed = [];
  const flaky = [];
  for (const [file, count] of tally) {
    if (count === rounds.length) stableRed.push(file);
    else flaky.push(file);
  }

  console.log('\n=== 逐轮失败文件 ===');
  rounds.forEach((set, idx) => {
    console.log(`轮次 ${idx + 1}（${set.size}）:`);
    for (const f of [...set].sort()) console.log(`  - ${f}`);
  });

  console.log(`\n=== 稳定红（${stableRed.length}，每轮都失败，需修或进基线）===`);
  for (const f of stableRed.sort()) console.log(`  - ${f}`);

  console.log(`\n=== 抖动 flaky（${flaky.length}，仅部分轮次失败，需排查时序/污染）===`);
  for (const f of flaky.sort()) {
    const count = tally.get(f);
    console.log(`  - ${f}（${count}/${rounds.length} 轮失败）`);
  }

  // 抖动存在时 exit 1，便于脚本化发现；稳定红不算 flaky，不影响退出码。
  process.exit(flaky.length > 0 ? 1 : 0);
}

main();
