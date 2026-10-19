#!/usr/bin/env node
/**
 * W35 性能回归基线（雏形，纯本地，不阻塞 CI）。
 *
 * 背景：tool-parser 的 extractToolCalls 曾因 `[\s\S]*?` 正则在长空白无匹配场景
 * 发生 catastrophic backtracking（ReDoS, H1）。没有基线，下次引入类似问题无人发现。
 *
 * 范围（规格备选：只做单一函数 extractToolCalls 的基线）：
 *   - 用 esbuild 把 extractToolCalls bundle 到临时 ESM，在 node 计时；
 *   - 输入为 10KB 无任何工具标签的普通文本（含长空白，即原 ReDoS 场景），验证线性、不爆；
 *   - 中位数耗时写入 tests/perf-baseline.json；当前 > 基线 150% 仅 WARN，不 exit 1。
 *
 * 运行：node scripts/perf-baseline.mjs
 */

import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASELINE_PATH = path.join(root, 'tests', 'perf-baseline.json');

const BYTES = 10_240; // 10KB 无匹配输入
const SAMPLES = 50;
const WARMUP = 5;
const WARN_RATIO = 1.5;

/** 构造 10KB 无工具标签文本，刻意含长空白（ReDoS 原场景）。 */
function buildInput() {
  const sentence = 'This is ordinary prose with no tool call tags here.     ';
  let text = '';
  while (Buffer.byteLength(text, 'utf8') < BYTES) text += sentence;
  return text;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function loadExtractToolCalls() {
  const entry = `import { extractToolCalls } from ${JSON.stringify(path.join(root, 'core/interceptor/tool-parser.ts'))};
globalThis.__extractToolCalls = extractToolCalls;`;
  const result = buildSync({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'perf-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const outDir = mkdtempSync(path.join(tmpdir(), 'dpp-perf-'));
  const outFile = path.join(outDir, 'bundle.mjs');
  writeFileSync(outFile, result.outputFiles[0].text, 'utf8');
  await import(pathToFileURL(outFile).href);
  const fn = globalThis.__extractToolCalls;
  rmSync(outDir, { recursive: true, force: true });
  if (typeof fn !== 'function') throw new Error('extractToolCalls 未成功导出');
  return fn;
}

function measure(fn, input) {
  for (let i = 0; i < WARMUP; i++) fn(input);
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    fn(input);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

async function main() {
  const fn = await loadExtractToolCalls();
  const input = buildInput();
  const medianMs = Math.round(measure(fn, input) * 1000) / 1000;

  let baseline = null;
  if (existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  }

  const record = {
    function: 'extractToolCalls',
    inputBytes: Buffer.byteLength(input, 'utf8'),
    samples: SAMPLES,
    medianMs,
    updatedAt: new Date().toISOString(),
  };

  // 首次无基线：直接记录并冻结，不算失败。后续运行只读基线对比，不回写覆盖，
  // 否则每次刷新基线将永远无法触发退化告警。
  if (!baseline || typeof baseline.medianMs !== 'number') {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(`extractToolCalls: ${medianMs}ms (${record.inputBytes}B) — baseline recorded (frozen)`);
    return;
  }

  const ratio = medianMs / baseline.medianMs;
  if (ratio > WARN_RATIO) {
    console.warn(
      `extractToolCalls: ${medianMs}ms (baseline ${baseline.medianMs}ms, ${ratio.toFixed(2)}x) WARN >1.5x（不阻塞）`,
    );
  } else {
    console.log(`extractToolCalls: ${medianMs}ms (baseline ${baseline.medianMs}ms, ${ratio.toFixed(2)}x) OK`);
  }
}

await main();
