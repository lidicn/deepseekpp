#!/usr/bin/env node
/**
 * M0-3 真实 trace 导出 / 脱敏脚本。
 *
 * 用法：
 *   node tools/eval/export-traces.mjs <input-traces.json> [out-dir]
 *
 * <input-traces.json> 为 inline agent traces 导出（浏览器控制台 __DPP_DEBUG__.export()
 * 或 dpp_inline_agent_traces 存储导出）。脚本将每条 trace 转成 golden fixture 骨架，
 * 严格脱敏，并按每页 ≤20 条分页写出。导出后会做明文自检（Bearer / Authorization /
 * sk- 密钥形态必须 0 命中），非 0 即退出码 1，避免把鉴权信息写进任务集。
 *
 * 不连真实网络、不回放请求；仅离线转换。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 20;

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|sessionid?)$/i;
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /sk-[A-Za-z0-9]{16,}/g,
  /"Authorization"\s*:/gi,
];

/** 递归脱敏：敏感 key 置 [REDACTED]；字符串里的 Bearer/sk- 抹除。 */
function redact(value, keyHint) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let out = value;
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, "[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v, k);
      }
    }
    return out;
  }
  return value;
}

function traceToFixture(trace, index) {
  const turns = Array.isArray(trace.steps)
    ? trace.steps.map((s, i) => ({
        index: i,
        modelDeclaredComplete: Boolean(s.completed && s.final),
        toolExecutions: Array.isArray(s.toolExecutions)
          ? s.toolExecutions.map((e) => ({ name: String(e.name ?? "tool"), ok: e.ok !== false }))
          : [],
        chainContinuable: s.chainContinuable !== false,
        budgetExhausted: Boolean(s.budgetExhausted),
      }))
    : [];
  const toolCallCount = turns.reduce((n, t) => n + t.toolExecutions.length, 0);
  const completed = trace.status === "complete";
  return redact({
    id: trace.id ? `trace-${trace.id}` : `trace-${index + 1}`,
    description: `由真实 trace 导出（${trace.status ?? "unknown"}）`,
    category: "real_trace",
    initialPrompt: trace.finalText ? `[redacted prompt, see trace #${index + 1}]` : "[redacted prompt]",
    expectedOutcome: completed ? "auto_completed" : "needed_user_continue",
    finalDepth: Number(trace.totalSteps) || turns.length,
    toolCallCount: Number(trace.totalTools) || toolCallCount,
    toolCalls: turns.flatMap((t) => t.toolExecutions).map((e) => ({ name: e.name, mock: { ok: e.ok } })),
    turns,
    provenance: "real_trace",
  });
}

function assertNoSecrets(text) {
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(...m);
  }
  if (hits.length > 0) {
    throw new Error("脱敏自检失败，仍检测到敏感明文：" + hits.slice(0, 3).join(" , "));
  }
}

function main() {
  const [, , inputPath, outArg] = process.argv;
  if (!inputPath) {
    console.log("用法：node tools/eval/export-traces.mjs <input-traces.json> [out-dir]");
    console.log("暂无真实 trace 输入；M0-3 合成任务集可直接运行 npm run eval:golden。");
    return;
  }
  const raw = JSON.parse(readFileSync(inputPath, "utf8"));
  const traces = Array.isArray(raw) ? raw : Array.isArray(raw.traces) ? raw.traces : [raw];
  const outDir = outArg || join(__dirname, "..", "..", "tests", "fixtures", "harness-golden", "real");
  mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (let page = 0; page * PAGE_SIZE < traces.length; page++) {
    const slice = traces.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const fixtures = slice.map((t, i) => traceToFixture(t, page * PAGE_SIZE + i));
    const text = JSON.stringify(fixtures, null, 2) + "\n";
    assertNoSecrets(text);
    const name = `real-page-${page + 1}.json`;
    writeFileSync(join(outDir, name), text, "utf8");
    written += fixtures.length;
  }
  console.log(`已导出 ${written} 条脱敏 trace（每页 ${PAGE_SIZE} 条）→ ${outDir}`);
}

main();
