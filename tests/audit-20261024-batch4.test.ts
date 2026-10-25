// 审计报告《deepseek-pp-审计报告.md》（2026-10-24）第四批：结构性守护。
//
// 本批收录：
//   #11 resume-gate 的 controller 生命周期 → 用例在 tests/resume-gate.test.ts
//   #29 narration 去重 Set 有上限        → 用例在 tests/inline-agent-narration-dedup.test.ts
//   #50 memory_search topK 校验          → 用例在 tests/memory-tool.test.ts
//   #46 stalledTimer 位置                → 本文件（结构断言）
//
// 另记录本批判为**假阳性 / 不改**的三条（核实后决定）：
//   #24 fetchWithTimeout 的「timer 泄漏」—— `common.ts:20` 的 abortScope.clearDeadline()
//       在响应到达时就清了定时器，审计陈述不成立；残留的只是 callerSignal 上的
//       abort listener（{once:true}，随 signal 释放）。
//   #39 stream-metrics 的 setInterval 泄漏 —— `response-interceptor.ts` 的 finish()
//       与 cancel() **两条路径都调了** speedTracker.finish()（:250 / :266），已覆盖。
//   #23 Streamable HTTP initialize 失败时的 sessionId —— 不采纳失败握手的 session
//       是**合理的防御**；要真清理得实现 MCP session DELETE，属功能缺口而非 bug。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

describe('审计 #46：stalledTimer 必须在授权成功后才起算', () => {
  const source = readSource('core/tool/runtime.ts');

  it('定时器创建点在授权 try/catch **之后**', () => {
    const timerAt = source.indexOf('const stalledTimer = setTimeout(');
    const authCatchAt = source.indexOf('if (!(error instanceof ToolAuthorizationError)) throw error;');
    expect(timerAt).toBeGreaterThan(-1);
    expect(authCatchAt).toBeGreaterThan(-1);
    // 关键顺序：授权流程先结束，才起「执行卡住」的计时
    expect(timerAt).toBeGreaterThan(authCatchAt);
  });

  it('定时器创建点在 parseError 早退之后（否则早退会留下空转定时器）', () => {
    const timerAt = source.indexOf('const stalledTimer = setTimeout(');
    const parseErrorAt = source.indexOf('if (identifiedCall.parseError) {');
    expect(parseErrorAt).toBeGreaterThan(-1);
    expect(timerAt).toBeGreaterThan(parseErrorAt);
  });

  it('执行阶段的 clearTimeout 仍然存在（负控：别把善后丢了）', () => {
    const clears = (source.match(/clearTimeout\(stalledTimer\)/g) ?? []).length;
    expect(clears).toBeGreaterThanOrEqual(2);
  });
});
