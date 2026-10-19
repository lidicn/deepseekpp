import { describe, it, expect } from 'vitest';
import {
  collectReplayedText,
  replaySseFrames,
} from '../core/trace/replay';

describe('replaySseFrames (W34)', () => {
  it('完整流：多帧按序拼接还原原文本', async () => {
    const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
    const text = await collectReplayedText(replaySseFrames(frames));
    expect(text).toBe(frames.join(''));
  });

  it('截断流：末帧不完整仍原样吐出，不补全不丢弃', async () => {
    const frames = ['data: {"partial":', '{"cut":'];
    const text = await collectReplayedText(replaySseFrames(frames));
    expect(text).toBe('data: {"partial":{"cut":');
    expect(text.endsWith('{"cut":')).toBe(true);
  });

  it('空流：迭代无输出，聚合为空字符串', async () => {
    const text = await collectReplayedText(replaySseFrames([]));
    expect(text).toBe('');
  });

  it('非字符串/空帧条目被跳过，不抛错', async () => {
    const text = await collectReplayedText(
      replaySseFrames(['keep', '', 'skip'] as unknown as string[]),
    );
    expect(text).toBe('keepskip');
  });
});
