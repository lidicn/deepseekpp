#!/usr/bin/env node
/**
 * M0-3 golden 任务集生成器（离线，一次性落盘）。
 *
 * 产物：src/tests/fixtures/harness-golden/task-XX.json（20 条代表性轨迹）。
 *
 * 这些是【人工设计的合成轨迹】，不回放真实网络、不含任何真实 prompt 明文 / 鉴权信息。
 * 每条 fixture 用声明式参数（steps / tools / nudge / break / budget）由下方 helper
 * 生成 turns，且 helper 与 golden-runner.mjs 共用同一套续跑状态机，确保
 * expectedOutcome 与 turns 数据自洽（runner 会再校验一次）。
 *
 * 当真实 trace 导出（export-traces.mjs）积累后，可用真实脱敏轨迹替换合成轨迹，
 * 但字段 schema 保持不变。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "tests", "fixtures", "harness-golden");

/** 与生产 INLINE_AGENT_MAX_NUDGES 对齐（三痛点修复后接线为 3）。 */
export const MAX_NUDGES = 3;

/**
 * 离线续跑状态机（生产 inline agent 续跑策略的简化镜像）。
 * 输入声明式参数，返回 { turns, expectedOutcome, finalDepth, toolCallCount }。
 *
 * @param {object} spec
 * @param {number} spec.steps       正常工作步数（含最终完成步）
 * @param {number[]} spec.toolsPerStep 每个工作步的工具调用数（长度=steps）
 * @param {number} [spec.nudges]    完成前插入的 nudge 次数（无工具、未声明完成）
 * @param {number|null} [spec.breakAt] 第几步（0-based，非首步）chain 断裂
 * @param {number|null} [spec.budgetAt] 第几步（0-based）预算耗尽暂停
 */
function pushWorkStep(turns, i, isLast, toolCount, chainContinuableOverride, budgetExhausted) {
  const executions = Array.from({ length: toolCount }, (_, k) => ({
    name: `tool_${i}_${k}`,
    ok: true,
  }));
  turns.push({
    index: turns.length,
    modelDeclaredComplete: isLast,
    toolExecutions: executions,
    chainContinuable: chainContinuableOverride ?? !isLast,
    budgetExhausted: Boolean(budgetExhausted),
  });
  return executions.length;
}

function buildTask(spec) {
  const turns = [];
  let toolCallCount = 0;
  let nudgeCount = 0;
  let expectedOutcome = "auto_completed";
  let finalDepth = 0;

  const totalSteps = spec.steps;
  for (let i = 0; i < totalSteps; i++) {
    // 预算耗尽：该步标记 pause，需用户继续
    if (spec.budgetAt === i) {
      toolCallCount += pushWorkStep(turns, i, false, spec.toolsPerStep?.[i] ?? 0, true, true);
      expectedOutcome = "needed_user_continue";
      finalDepth = turns.length;
      return { turns, expectedOutcome, finalDepth, toolCallCount };
    }

    // 非首步 chain 断裂（如 parentMessageId 丢失）：fail-closed，需用户继续
    if (spec.breakAt === i && i > 0) {
      toolCallCount += pushWorkStep(turns, i, false, spec.toolsPerStep?.[i] ?? 0, false, false);
      expectedOutcome = "needed_user_continue";
      finalDepth = turns.length;
      return { turns, expectedOutcome, finalDepth, toolCallCount };
    }

    // 首个工作步之后、继续之前，集中产生连续 nudge（模型空转不声明完成）
    if (i === 1 && spec.nudges) {
      while (nudgeCount < spec.nudges) {
        turns.push({
          index: turns.length,
          modelDeclaredComplete: false,
          toolExecutions: [],
          chainContinuable: true,
          budgetExhausted: false,
          nudge: true,
        });
        nudgeCount++;
        if (nudgeCount > MAX_NUDGES) {
          expectedOutcome = "needed_user_continue";
          finalDepth = turns.length;
          return { turns, expectedOutcome, finalDepth, toolCallCount };
        }
      }
    }

    const isLast = i === totalSteps - 1;
    toolCallCount += pushWorkStep(turns, i, isLast, spec.toolsPerStep?.[i] ?? 0);
    if (isLast) finalDepth = turns.length;
  }

  return { turns, expectedOutcome, finalDepth, toolCallCount };
}

/** 20 条任务定义（17 自动完成 / 3 需用户继续，含长会话、首步工具、断链、预算、nudge）。 */
const SPECS = [
  { id: "task-01", category: "simple", desc: "单轮纯问答，无工具", steps: 1, toolsPerStep: [0] },
  { id: "task-02", category: "simple", desc: "单轮读取一个文件即完成", steps: 1, toolsPerStep: [1] },
  { id: "task-03", category: "simple", desc: "两步：读文件后回答", steps: 2, toolsPerStep: [1, 0] },
  { id: "task-04", category: "simple", desc: "两步澄清后回答，无工具", steps: 2, toolsPerStep: [0, 0] },
  { id: "task-05", category: "simple", desc: "单轮并行读两个文件", steps: 1, toolsPerStep: [2] },
  { id: "task-06", category: "simple", desc: "三步：读、改、确认", steps: 3, toolsPerStep: [1, 1, 0] },
  { id: "task-07", category: "multi_step", desc: "四步工具链，逐步推进", steps: 4, toolsPerStep: [1, 1, 1, 1] },
  { id: "task-08", category: "multi_step", desc: "五步：首步并行两工具", steps: 5, toolsPerStep: [2, 1, 1, 1, 0] },
  { id: "task-09", category: "multi_step", desc: "六步多工具任务", steps: 6, toolsPerStep: [1, 2, 1, 1, 1, 0] },
  { id: "task-10", category: "multi_step", desc: "五步连续工具调用", steps: 5, toolsPerStep: [1, 1, 1, 1, 1] },
  { id: "task-11", category: "long_session", desc: "长会话：七步，含并行工具", steps: 7, toolsPerStep: [2, 2, 1, 1, 1, 1, 0] },
  { id: "task-12", category: "long_session", desc: "长会话：八步深度任务", steps: 8, toolsPerStep: [1, 1, 2, 2, 1, 1, 1, 0] },
  { id: "task-13", category: "first_turn_tool", desc: "第一步即调用工具（P1-2 关键场景）", steps: 4, toolsPerStep: [2, 1, 1, 0] },
  { id: "task-14", category: "nudge_recovered", desc: "中途一次 nudge 后自动完成", steps: 3, toolsPerStep: [1, 1, 0], nudges: 1 },
  { id: "task-15", category: "nudge_recovered", desc: "两次 nudge 后自动完成", steps: 4, toolsPerStep: [1, 1, 1, 0], nudges: 2 },
  { id: "task-16", category: "multi_step", desc: "五步工具链收尾", steps: 5, toolsPerStep: [1, 1, 1, 1, 0] },
  { id: "task-17", category: "simple", desc: "三步读-答-读", steps: 3, toolsPerStep: [1, 0, 1] },
  { id: "task-18", category: "chain_broken", desc: "第 4 步 parent 链断裂，需用户继续", steps: 6, toolsPerStep: [1, 1, 1, 1, 1, 0], breakAt: 3 },
  { id: "task-19", category: "budget_paused", desc: "长任务第 6 步预算耗尽暂停", steps: 8, toolsPerStep: [1, 1, 1, 1, 1, 1, 1, 0], budgetAt: 5 },
  { id: "task-20", category: "nudge_exhausted", desc: "nudge 超过上限（>3）仍未完成", steps: 2, toolsPerStep: [1, 0], nudges: 4 },
];

function categoryToOutcome(category) {
  if (category === "chain_broken" || category === "budget_paused" || category === "nudge_exhausted") {
    return "needed_user_continue";
  }
  return "auto_completed";
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of SPECS) {
    const built = buildTask(spec);
    const fixture = {
      id: spec.id,
      description: spec.desc,
      category: spec.category,
      initialPrompt: `[synthetic] ${spec.desc}（脱敏占位，无真实提示）`,
      expectedOutcome: categoryToOutcome(spec.category),
      finalDepth: built.finalDepth,
      toolCallCount: built.toolCallCount,
      toolCalls: built.turns.flatMap((t) => t.toolExecutions).map((e) => ({ name: e.name, mock: { ok: true } })),
      turns: built.turns,
      provenance: "synthetic",
    };
    // 状态机推导的 outcome 必须与类别声明一致（自洽守卫）
    if (fixture.expectedOutcome !== built.expectedOutcome) {
      throw new Error(`fixture ${spec.id} 不自洽: category=${fixture.expectedOutcome} sim=${built.expectedOutcome}`);
    }
    writeFileSync(join(OUT_DIR, `${spec.id}.json`), JSON.stringify(fixture, null, 2) + "\n", "utf8");
  }
  console.log(`已生成 ${SPECS.length} 条 golden fixture → ${OUT_DIR}`);
}

main();
