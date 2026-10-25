/**
 * P0-2: inline-agent narration 渲染幂等守卫（模块级 Set）。
 *
 * 背景：结论无论来自 nudge 续轮还是正常 step，handleAgentLoopComplete 在
 * 重复派发（重复 AGENT_LOOP_COMPLETE / 收尾分支重入）时会再次调用
 * appendInlineAgentNarration，导致同一轮的最终答案被渲染两份。旧实现只给
 * 已渲染元素打 data-dpp-agent-loop-id 属性，不阻断重复调用。
 *
 * 本模块把「该 loopId 是否已渲染过 narration」收敛为模块作用域 Set（必须是
 * 模块级，不能放函数内，否则每次调用都新建 Set 失效）。纯逻辑、无 IO、便于单测。
 */

const renderedNarrationLoops = new Set<string>();

/**
 * 审计 #29（2026-10-24 报告 P1）：这是**模块级** Set，每个 loopId 只增不删。
 * content script 生命周期内会跑很多轮对话，长时间使用后它无界增长
 * （每项一个 loopId 字符串，增长慢但确实不会回退）。
 *
 * 加上限：超过后按插入顺序淘汰最早的。去重的实际有效窗口很短
 * （只防同一轮的重复派发），淘汰老 id 不会让去重失效。
 */
const MAX_RENDERED_NARRATION_LOOPS = 500;

function evictOldestNarrationLoops(): void {
  if (renderedNarrationLoops.size <= MAX_RENDERED_NARRATION_LOOPS) return;
  const overflow = renderedNarrationLoops.size - MAX_RENDERED_NARRATION_LOOPS;
  let removed = 0;
  // Set 保持插入顺序，从头迭代即为最早登记的
  for (const loopId of renderedNarrationLoops) {
    if (removed >= overflow) break;
    renderedNarrationLoops.delete(loopId);
    removed += 1;
  }
}

/**
 * 判定该 loopId 的 narration 是否应渲染；首次调用放行并登记，重复调用返回 false。
 * 空/缺失 loopId 不拦截（保持旧行为：无 id 的调用照常渲染）。
 */
export function shouldRenderNarration(loopId: string | null | undefined): boolean {
  if (!loopId) return true;
  if (renderedNarrationLoops.has(loopId)) return false;
  renderedNarrationLoops.add(loopId);
  evictOldestNarrationLoops();
  return true;
}

/** 测试专用：清空登记，避免用例间串扰。 */
export function resetNarrationDedup(): void {
  renderedNarrationLoops.clear();
}
