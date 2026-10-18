/**
 * 痛点 1-B（P1-2）：web 后端第一步工具调用的链续判定。
 *
 * 背景：web 路径以 DeepSeek 页面会话链（parentMessageId）为权威。该 id 在
 * 第一个 assistant turn 真正落地后才由 stream 回调写入。因此当模型【第一步就
 * 调用工具】时，工具执行拦截（beforeToolCall）发生在 id 建立之前，旧逻辑直接
 * 返回 false → fail-closed 误杀，任务在第一步断流（痛点 1-B）。
 *
 * 修复：首轮（stepIndex===0，含该步的 nudge 续轮）即使 parentMessageId 尚未建立
 * 也放行；从第二个 step 起恢复严格要求 parentMessageId !== null。
 *
 * 注意：不能削弱链分叉防护——第二轮（stepIndex>=1）parentMessageId 丢失仍必须
 * 阻断（回归 R2）。本函数为纯函数，便于单测，不含任何 IO。
 */
export function webHasContinuableChain(input: {
  stepIndex: number;
  parentMessageId: number | null;
}): boolean {
  // 首轮放行：第一步工具调用不再被误杀。
  if (input.stepIndex === 0) return true;
  // 第二轮起严格：必须有有效页面链父 id。
  return input.parentMessageId !== null;
}
