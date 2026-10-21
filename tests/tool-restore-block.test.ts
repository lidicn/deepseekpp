import { describe, expect, it } from 'vitest';
import {
  createToolRestoreBlockId,
  createToolRestoreBlockIdCandidates,
  createToolRestoreBlockUrl,
} from '../core/tool/restore-block';

describe('tool restore block identity', () => {
  it('keeps one stable restore id for a streamed response as content and assistant ids change', () => {
    const first = createToolRestoreBlockId({
      requestId: 'req-1',
      chatSessionId: 'session-a',
      parentMessageId: 10,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: 'first tool output',
    });
    const completed = createToolRestoreBlockId({
      requestId: 'req-1',
      chatSessionId: 'session-a',
      parentMessageId: 10,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: 'final answer with more tool output',
    });

    expect(completed).toBe(first);
  });

  it('derives a session URL from the source chat session instead of the current route', () => {
    const url = createToolRestoreBlockUrl({
      origin: 'https://chat.deepseek.com',
      pathname: '/a/chat/s/current-session',
      search: '?from=sidebar',
      chatSessionId: 'original/session',
    });

    expect(url).toBe('https://chat.deepseek.com/a/chat/s/original%2Fsession');
  });

  it('falls back to the current full route when there is no chat session id', () => {
    const url = createToolRestoreBlockUrl({
      origin: 'https://chat.deepseek.com',
      pathname: '/a/chat',
      search: '?q=1',
      chatSessionId: null,
    });

    expect(url).toBe('https://chat.deepseek.com/a/chat?q=1');
  });

  // 2026-10-22 回归：创建侧与完成侧字段不一致时，单值 id 会落进不同分支。
  // 真机现象：工具执行成功，但 RESPONSE_COMPLETE 时 completedExecutions 为空。
  //
  // 注意：候选只能覆盖「完成侧也带得上」的维度。若创建侧用了 requestId 而完成侧
  // requestId 为空，request 分支的 id 无法从完成侧反推——那种情况要靠
  // getCurrentRouteActiveToolBlockSession() / activeToolBlockSessionId 兜底。
  it('候选 id 覆盖 parentMessageId 不一致的情况', () => {
    // 创建侧与完成侧 chatSessionId 相同，但 parentMessageId 不同
    const created = createToolRestoreBlockId({
      requestId: null,
      chatSessionId: 'session-a',
      parentMessageId: 10,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: '<shell_exec>{"command":"echo hi"}</shell_exec>',
    });
    const completed = createToolRestoreBlockId({
      requestId: null,
      chatSessionId: 'session-a',
      parentMessageId: 11,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: '把命令结果告诉我',
    });

    // 修复前：parentMessageId 不同 → 单值 id 不同 → 精确查找必然 miss
    expect(completed).not.toBe(created);

    // 修复后：完成侧的候选同时含「自己的」和「不带 parentMessageId 的」
    const candidates = createToolRestoreBlockIdCandidates({
      requestId: null,
      chatSessionId: 'session-a',
      parentMessageId: 11,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: '把命令结果告诉我',
    });
    expect(candidates).toContain(completed);
    // 共 3 条：chat(带 parentMessageId) / chat(不带) / route
    expect(candidates).toHaveLength(3);
    // 第二条是「不带 parentMessageId」的那条，能兜住 parentMessageId 漂移
    expect(candidates[1]).toBe(createToolRestoreBlockId({
      requestId: null,
      chatSessionId: 'session-a',
      parentMessageId: null,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-a',
      fallbackSeed: 'ignored',
    }));
  });

  it('候选 id 去重且保序（requestId 优先）', () => {
    const identity = {
      requestId: 'req-7',
      chatSessionId: 'session-b',
      parentMessageId: 3,
      fallbackUrl: 'https://chat.deepseek.com/a/chat/s/session-b',
      fallbackSeed: 'seed',
    };
    const candidates = createToolRestoreBlockIdCandidates(identity);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe(createToolRestoreBlockId(identity));
    // request: 一条、chat: 两条、route: 一条
    expect(candidates).toHaveLength(4);
  });
});
