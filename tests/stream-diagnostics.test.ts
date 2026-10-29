/**
 * 流结束诊断（P0-1）守卫：只验"如实记录"，不验"算不算截断"。
 *
 * 变异（可判红）：
 *   ① 把 BATCH 里 quasi_status 的解析删掉 ⇒ 用例 2 红
 *   ② `toolFragmentUnfinished` 改成永远 false ⇒ 用例 4 红
 */
import { describe, expect, it } from 'vitest';
import {
  createStreamDiagnostics,
  formatStreamDiagnostics,
} from '../core/deepseek/stream-diagnostics';

describe('stream-diagnostics', () => {
  it('★ 记录最后状态帧（response/status PREEMPTED）', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed({ p: 'response/fragments/-1/content', o: 'APPEND', v: 'x' }, 'message');
    diag.noteParsed({ p: 'response/status', v: 'PREEMPTED' }, 'status');
    diag.noteEnd('done');

    const snap = diag.snapshot();
    expect(snap.lastFrameStatus).toBe('PREEMPTED');
    expect(snap.lastFramePath).toBe('response/status');
    expect(snap.frameCount).toBe(2);
    expect(snap.eventTypeCounts).toEqual({ message: 1, status: 1 });
    expect(snap.endedBy).toBe('done');
  });

  it('★ BATCH 帧里的 quasi_status 也要能抓到（否则永远看不见真正的结束原因）', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed(
      { o: 'BATCH', v: [{ p: 'quasi_status', v: 'FINISHED' }, { p: 'x', v: 'y' }] },
      'batch',
    );
    expect(diag.snapshot().lastFrameStatus).toBe('FINISHED');
  });

  it('★ 工具轮特征：见过 TOOL fragment 但没 FINISHED ⇒ toolFragmentUnfinished=true', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed({ p: 'response/fragments/-1/content', v: '{"name":' }, 'message');
    diag.noteFragmentTypes(['TOOL']);
    diag.noteMessageIds(4);
    diag.noteEnd('done');

    const snap = diag.snapshot();
    expect(snap.sawToolFragment).toBe(true);
    expect(snap.toolFragmentUnfinished).toBe(true);
    expect(snap.responseMessageId).toBe(4);
  });

  it('★ 有 TOOL fragment 且拿到 FINISHED ⇒ toolFragmentUnfinished=false（正常收尾）', () => {
    const diag = createStreamDiagnostics();
    diag.noteFragmentTypes(['TOOL']);
    diag.noteParsed({ p: 'response/status', v: 'FINISHED' }, 'status');
    diag.noteEnd('done');
    expect(diag.snapshot().toolFragmentUnfinished).toBe(false);
  });

  it('负控：读流抛错（连接重置）要能和正常结束区分', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed({ p: 'response/fragments/-1/content', v: 'a' }, 'message');
    diag.noteEnd('error');
    expect(diag.snapshot().endedBy).toBe('error');
  });

  it('负控：脏输入不炸（null / 数组 / 字符串）', () => {
    const diag = createStreamDiagnostics();
    expect(() => {
      diag.noteParsed(null);
      diag.noteParsed([]);
      diag.noteParsed('x');
      diag.noteParsed({ v: -1 });
      diag.noteFragmentTypes([]);
      diag.noteMessageIds(null);
    }).not.toThrow();
    const snap = diag.snapshot();
    expect(snap.frameCount).toBe(4);
    expect(snap.responseMessageId).toBeNull();
  });

  it('★ 一行格式：包含定位所需的全部键', () => {
    const diag = createStreamDiagnostics();
    diag.noteParsed({ p: 'response/status', v: 'FAILED' }, 'status');
    diag.noteFragmentTypes(['TOOL']);
    diag.noteMessageIds(7);
    diag.noteEnd('done');
    const line = formatStreamDiagnostics(diag.snapshot());
    for (const key of ['endedBy=', 'frames=', 'lastEvent=', 'lastPath=', 'lastStatus=', 'fragments=', 'toolUnfinished=', 'msgId=']) {
      expect(line).toContain(key);
    }
    expect(line).toContain('FAILED');
    expect(line).toContain('msgId=7');
  });
});
