/**
 * #P1 — mergeRestoredTranscript 纯函数测试
 *
 * 覆盖：
 * 1. 空 messages + 有 chunks → 生成一条 assistant
 * 2. 最后一条是 assistant → 追加到它上面（不新起一条）
 * 3. chunks 乱序 → 按 seq 排序
 * 4. 重复 seq → 去重
 * 5. chunks 无重复但 messages 空 → 仍能生成 assistant
 * 6. reasoningText 也被正确追加
 *
 * 变异自证：
 * - 去掉 dedupedSorted 里的 seen Set 过滤 → 用例 4 红
 * - 去掉 sort → 用例 3 红
 */
import { describe, expect, it } from 'vitest';
import { mergeRestoredTranscript } from '../core/transcript-merge';
import type { ChatMessage } from '../core/types';

function mkChunk(seq: number, text: string, reasoningText?: string) {
  return { seq, text, at: Date.now(), reasoningText };
}

describe('#P1 mergeRestoredTranscript — pendingChunks 合并到 messages', () => {
  it('空 messages + 有 chunks → 生成一条 assistant', () => {
    const result = mergeRestoredTranscript([], [mkChunk(1, '你好'), mkChunk(2, '世界')]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: 'assistant' });
    expect(result.messages[0]!.text).toBe('你好世界');
    expect(result.assistantIndex).toBe(0);
  });

  it('最后一条是 assistant → 追加到它上面（不新起一条）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'test' },
      { role: 'assistant', text: '已有开头' },
    ];
    const result = mergeRestoredTranscript(messages, [mkChunk(1, '追加内容')]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[1]!.text).toBe('已有开头追加内容');
    // 原始 messages 不应被突变
    expect(messages[1]!.text).toBe('已有开头');
  });

  it('chunks 乱序 → 按 seq 排序后合并', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'test' },
      { role: 'assistant', text: '' },
    ];
    // 乱序 seq
    const result = mergeRestoredTranscript(messages, [
      mkChunk(3, 'C'),
      mkChunk(1, 'A'),
      mkChunk(2, 'B'),
    ]);
    expect(result.messages[1]!.text).toBe('ABC');
  });

  it('重复 seq → 去重（只取第一次出现）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'test' },
      { role: 'assistant', text: '' },
    ];
    // seq=2 出现两次 — 第二次应被丢弃
    const result = mergeRestoredTranscript(messages, [
      mkChunk(1, 'A'),
      mkChunk(2, 'B-first'),
      mkChunk(2, 'B-duplicate'),
      mkChunk(3, 'C'),
    ]);
    expect(result.messages[1]!.text).toBe('AB-firstC');
  });

  it('reasoningText 也被正确追加', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', text: '答案', reasoningText: '思考' },
    ];
    const result = mergeRestoredTranscript(messages, [
      { seq: 1, text: '补充', reasoningText: '继续思考', at: 1 },
    ]);
    expect(result.messages[0]!.text).toBe('答案补充');
    expect(result.messages[0]!.reasoningText).toBe('思考继续思考');
  });

  it('chunks 为空 → 返回 messages 浅拷贝，assistantIndex=-1', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'test' },
    ];
    const result = mergeRestoredTranscript(messages, []);
    expect(result.messages).toEqual([{ role: 'user', text: 'test' }]);
    expect(result.messages).not.toBe(messages); // 浅拷贝
    expect(result.assistantIndex).toBe(-1);
  });
});
