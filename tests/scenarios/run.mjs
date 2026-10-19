#!/usr/bin/env node
/**
 * W32 端到端场景测试框架（雏形，纯本地，无外部依赖、不接真实模型/网络）。
 *
 * 目录约定：本文件同目录下 `scenarios/*.json`，每个文件是一个声明式场景：
 *   {
 *     "name": string,
 *     "description": string,
 *     "turns": [{ kind, finished, toolCalls: [], text, eofNoFinish }],
 *     "expect": { turnCount, toolCallCount, allFinished, endedCleanly }
 *   }
 *
 * 雏形阶段：驱动器在纯内存里聚合 turns 并对照 expect 断言，先把「场景 JSON schema +
 * 驱动断言 + PASS/FAIL 汇总」骨架立住。后续接入真实 readCompletionStream 时，
 * 把 turns 的来源从声明值替换为真实 SSE 回放，expect 契约不变。
 *
 * 运行：node tests/scenarios/run.mjs；任一场景失败退出码为 1。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, 'scenarios');

/** 纯内存聚合一个场景的 turns，得到可断言的实际值。 */
function evaluateScenario(scenario) {
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  const assistantTurns = turns.filter((t) => t.kind === 'assistant');
  const toolCallCount = turns.reduce(
    (sum, t) => sum + (Array.isArray(t.toolCalls) ? t.toolCalls.length : 0),
    0,
  );
  const allFinished = assistantTurns.every((t) => t.finished === true);
  const hasUnfinishedEof = assistantTurns.some((t) => t.eofNoFinish === true);
  const endedCleanly = allFinished && !hasUnfinishedEof;

  return {
    turnCount: turns.length,
    toolCallCount,
    allFinished,
    endedCleanly,
  };
}

/** 对照 expect 逐项断言，返回失败描述列表（空 = 通过）。 */
function checkExpectations(actual, expect) {
  const failures = [];
  const keys = Object.keys(expect ?? {});
  for (const key of keys) {
    if (!(key in actual)) {
      failures.push(`未知期望键 "${key}"`);
      continue;
    }
    if (actual[key] !== expect[key]) {
      failures.push(
        `expect ${key}=${JSON.stringify(expect[key])} but got ${JSON.stringify(actual[key])}`,
      );
    }
  }
  return failures;
}

function loadScenarios() {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const raw = readFileSync(join(scenariosDir, file), 'utf8');
    try {
      // 去掉可能的 BOM，避免坏编码让整个驱动器崩溃。
      const scenario = JSON.parse(raw.replace(/^﻿/, ''));
      return { file, scenario, parseError: null };
    } catch (error) {
      return { file, scenario: null, parseError: error.message };
    }
  });
}

function main() {
  let passed = 0;
  let failed = 0;
  const scenarios = loadScenarios();

  if (scenarios.length === 0) {
    console.error('FAIL: 未发现任何场景 JSON（tests/scenarios/scenarios/*.json）');
    process.exit(1);
  }

  for (const { file, scenario, parseError } of scenarios) {
    if (parseError) {
      failed += 1;
      console.log(`FAIL  (${file}) 解析失败: ${parseError}`);
      continue;
    }
    const actual = evaluateScenario(scenario);
    const failures = checkExpectations(actual, scenario.expect);
    if (failures.length === 0) {
      passed += 1;
      console.log(`PASS  ${scenario.name} (${file})`);
    } else {
      failed += 1;
      console.log(`FAIL  ${scenario.name} (${file})`);
      for (const reason of failures) {
        console.log(`        - ${reason}`);
      }
    }
  }

  console.log(`\n场景汇总: ${passed} passed, ${failed} failed, ${scenarios.length} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
