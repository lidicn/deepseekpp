/**
 * 断流止血守卫（P0-2 / P0-3）。
 *
 * 背景：`断流根因与修复方案-20261029.md` —— 一次截断被 nudge 放大成 8 次空转，
 * 因为 `shouldNudge` 第一条就是「空文本必续」。同时"工具轮正常收尾"与"真截断"
 * 在旧判据下同形，于是每个纯工具轮都报一次疑似截断。
 *
 * 变异（可判红）：
 *   - 恢复 `if (!visibleText) return true;` ⇒ 用例 1 红
 *   - `classifyStreamEnd` 去掉 `responseMessageId !== null` 判据 ⇒ 用例 4 红
 *   - MAX_NUDGES 改回 8 ⇒ 用例 6 红
 */
import { describe, expect, it } from 'vitest';
import { shouldNudge } from '../core/inline-agent/prompt';
import { INLINE_AGENT_MAX_NUDGES } from '../core/inline-agent/types';
import {
  classifyStreamEnd,
  createStreamDiagnostics,
  type StreamDiagnosticsSnapshot,
} from '../core/deepseek/stream-diagnostics';

const exec = (id: string) => ({ id, name: 'shell_exec', status: 'success' } as never);

function snapshot(overrides: Partial<StreamDiagnosticsSnapshot>): StreamDiagnosticsSnapshot {
  return {
    frameCount: 10,
    eventTypeCounts: {},
    lastEventType: 'message',
    lastFramePath: 'response/fragments/-1/content',
    lastFrameStatus: null,
    lastFrameOperation: 'APPEND',
    fragmentTypes: [],
    sawToolFragment: false,
    toolFragmentUnfinished: false,
    responseMessageId: null,
    endedBy: 'done',
    ...overrides,
  };
}

describe('shouldNudge · 空文本不再无条件续轮（P0-3）', () => {
  it('★★ 空文本 + 无工具执行 ⇒ 不续（旧实现此处为 true，会空转 8 次）', () => {
    expect(shouldNudge('审计这个仓库', [], '')).toBe(false);
    expect(shouldNudge('审计这个仓库', [], '   \n  ')).toBe(false);
  });

  it('★ 空文本 + 有工具执行 ⇒ 仍续（有结果要总结）', () => {
    expect(shouldNudge('审计这个仓库', [exec('a')], '')).toBe(true);
  });

  it('负控：有正文且以句末标点结尾 ⇒ 不续（原有行为不变）', () => {
    expect(shouldNudge('审计这个仓库', [], '根据搜索结果，恒生指数今日下跌。')).toBe(false);
  });

  it('负控：task_complete 信号 ⇒ 不续', () => {
    expect(shouldNudge('审计这个仓库', [exec('a')], '任务完成<task_complete>{"summary":"ok"}</task_complete>')).toBe(false);
  });
});

describe('classifyStreamEnd · 区分工具轮收尾与真截断（P0-2）', () => {
  it('★ 见到 FINISHED ⇒ clean', () => {
    expect(classifyStreamEnd(snapshot({ lastFrameStatus: 'FINISHED' }))).toBe('clean');
  });

  it('★ 读流抛错 ⇒ connection-error', () => {
    expect(classifyStreamEnd(snapshot({ endedBy: 'error' }))).toBe('connection-error');
  });

  it('★★ 见过 TOOL fragment + 正 id + 无 FINISHED ⇒ tool-turn-close（不是截断）', () => {
    expect(
      classifyStreamEnd(
        snapshot({ sawToolFragment: true, toolFragmentUnfinished: true, responseMessageId: 4 }),
      ),
    ).toBe('tool-turn-close');
  });

  it('★★ 见过 TOOL fragment 但**没有 id** ⇒ truncated（真截断，不能放过）', () => {
    expect(
      classifyStreamEnd(
        snapshot({ sawToolFragment: true, toolFragmentUnfinished: true, responseMessageId: null }),
      ),
    ).toBe('truncated');
  });

  it('负控：既无 fragment 也无 id ⇒ truncated', () => {
    expect(classifyStreamEnd(snapshot({}))).toBe('truncated');
  });
});

describe('nudge 上限（P0-3）', () => {
  it('★ 从 8 降到 3，避免一次截断放大成 8 次空转', () => {
    expect(INLINE_AGENT_MAX_NUDGES).toBe(3);
  });
});

describe('诊断器到分类器的端到端一致性', () => {
  it('★ 真实帧序列：TOOL fragment + 正 id + 无结束帧 ⇒ tool-turn-close', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed({ p: 'response/fragments/-1/content', o: 'APPEND', v: '{"name":"shell_exec"' }, 'message');
    diag.noteFragmentTypes(['TOOL']);
    diag.noteMessageIds(8);
    diag.noteEnd('done');
    expect(classifyStreamEnd(diag.snapshot())).toBe('tool-turn-close');
  });
});
