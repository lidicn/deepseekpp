#!/usr/bin/env node
/**
 * M0-3 golden 离线评测器。
 *
 * 读取 tests/fixtures/harness-golden/*.json，用【独立的续跑状态机】从 turns 重放
 * （不直接信任 fixture.expectedOutcome），判定每条任务：
 *   auto_completed / needed_user_continue
 * 并与 fixture 标注的 expectedOutcome 比对（标注一致性 = 100% 才合格）。
 *
 * 输出 G1/G2 关注的分布：自动完成率、需用户继续率、平均深度、平均工具调用数。
 * 全程离线、不回放真实网络。
 *
 * 运行：npm run eval:golden   （或 node tools/eval/golden-runner.mjs）
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "..", "tests", "fixtures", "harness-golden");
const MAX_NUDGES = 3;

/**
 * 从 turns 重放的续跑状态机。这是生产 inline agent 续跑规则的离线镜像：
 * - budgetExhausted：暂停，需用户继续
 * - 非首步 chainContinuable=false：fail-closed 阻断，需用户继续
 * - 首步（index=0）即使 chainContinuable=false 也放行（P1-2 首轮放行后的预期行为）
 * - 无工具、未完成的 nudge turn：计数，超过 MAX_NUDGES 需用户继续
 * - modelDeclaredComplete：自动完成
 */
function replay(fixture) {
  let nudgeCount = 0;
  for (const turn of fixture.turns) {
    const hasTools = turn.toolExecutions.length > 0;

    if (turn.budgetExhausted) {
      return { outcome: "needed_user_continue", reason: "budget_exhausted" };
    }

    // 声明完成优先：最后一步即使 chainContinuable=false（自然结束）也属自动完成。
    if (turn.modelDeclaredComplete) {
      return { outcome: "auto_completed", reason: "declared_complete" };
    }

    if (hasTools && !turn.chainContinuable && turn.index > 0) {
      return { outcome: "needed_user_continue", reason: "chain_broken" };
    }

    if (!hasTools && !turn.modelDeclaredComplete) {
      nudgeCount++;
      if (nudgeCount > MAX_NUDGES) {
        return { outcome: "needed_user_continue", reason: "max_nudges_exceeded" };
      }
    }
  }
  return { outcome: "needed_user_continue", reason: "ran_out_of_turns" };
}

function pct(n, total) {
  return total === 0 ? "0%" : `${Math.round((n / total) * 1000) / 10}%`;
}

function main() {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    console.error("未找到 golden fixture，请先运行：node tools/eval/build-fixtures.mjs");
    process.exit(1);
  }

  const results = [];
  let mismatch = 0;
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    const sim = replay(fixture);
    const consistent = sim.outcome === fixture.expectedOutcome;
    if (!consistent) mismatch++;
    results.push({
      id: fixture.id,
      category: fixture.category,
      expected: fixture.expectedOutcome,
      actual: sim.outcome,
      reason: sim.reason,
      depth: fixture.finalDepth,
      tools: fixture.toolCallCount,
      consistent,
    });
  }

  const total = results.length;
  const auto = results.filter((r) => r.actual === "auto_completed").length;
  const need = total - auto;
  const avgDepth = Math.round((results.reduce((s, r) => s + r.depth, 0) / total) * 10) / 10;
  const avgTools = Math.round((results.reduce((s, r) => s + r.tools, 0) / total) * 10) / 10;

  console.log("Golden Eval: " + total + " tasks");
  console.log(`  auto-completed: ${auto}/${total} (${pct(auto, total)})`);
  console.log(`  needed user continue: ${need}/${total} (${pct(need, total)})`);
  console.log(`  avg depth: ${avgDepth}`);
  console.log(`  avg tool calls: ${avgTools}`);
  console.log(`  label consistency: ${total - mismatch}/${total} (${pct(total - mismatch, total)})`);

  if (mismatch > 0) {
    console.error("\n标注不一致的 fixture：");
    for (const r of results.filter((x) => !x.consistent)) {
      console.error(`  - ${r.id} [${r.category}] expected=${r.expected} actual=${r.actual} (${r.reason})`);
    }
    process.exit(1);
  }
  console.log("\nPASS：全部 fixture 标注与离线状态机判定一致。");
}

main();
