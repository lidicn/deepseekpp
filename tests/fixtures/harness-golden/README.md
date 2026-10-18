# Harness Golden 任务集（M0-3）

离线、确定性的 inline agent 续跑评测集。**不回放真实网络、不含真实 prompt 明文 / 鉴权信息。**

## 结构

- `task-01 … task-20.json`：20 条人工设计的合成轨迹（由 `tools/eval/build-fixtures.mjs` 生成）。
- `real/`（可选）：由 `tools/eval/export-traces.mjs` 从真实 trace 脱敏导出的分页结果（每页 ≤20 条）。

## fixture schema

```jsonc
{
  "id": "task-13",
  "description": "第一步即调用工具（P1-2 关键场景）",
  "category": "first_turn_tool",
  "initialPrompt": "[synthetic] …（脱敏占位）",
  "expectedOutcome": "auto_completed | needed_user_continue",
  "finalDepth": 4,
  "toolCallCount": 4,
  "toolCalls": [{ "name": "tool_0_0", "mock": { "ok": true } }],
  "turns": [
    {
      "index": 0,
      "modelDeclaredComplete": false,
      "toolExecutions": [{ "name": "tool_0_0", "ok": true }],
      "chainContinuable": true,
      "budgetExhausted": false
    }
  ],
  "provenance": "synthetic"
}
```

## 运行

```bash
npm run eval:golden                 # 离线评测全部 fixture，输出自动完成率/平均深度/工具数
node tools/eval/build-fixtures.mjs  # 重新生成 20 条合成 fixture
node tools/eval/export-traces.mjs <traces.json>   # 真实 trace 脱敏导入（分页≤20）
```

## 指标含义（对齐 G1/G2）

- `auto-completed`：任务在无人工“继续”情况下自然走到 `task_complete`。
- `needed user continue`：断链（fail-closed）/ 预算耗尽暂停 / nudge 超上限，需人工继续。
- `avg depth`：完成深度（turn 数）；`avg tool calls`：每条任务工具调用数。

## 边界

- 状态机是生产 inline agent 续跑策略的**离线镜像**（见 `golden-runner.mjs` 头部注释），用于回归
  策略参数与任务分布；不是真实端到端评测。生产逻辑改动后需同步更新 runner 镜像。
- 本目录不进 wxt 扩展包（`tools/eval/**` 不进 `wxt.config`、不进 `ci:quality`）。
