/**
 * 审计 #67：`callLocalFileReadAuto` 的自动续读必须校验**窗口连续性**。
 *
 * 宿主约定 `nextStart = start + charsRead`。原实现只校验「必须前进」
 * （`nextStart <= prevNextStart` 才 fail-closed），因此：
 *   · 实际更大 ⇒ **gap**：两窗之间有一段字被跳过（静默漏字）
 *   · 实际更小 ⇒ **overlap**：两窗重叠，拼接后出现重复文本
 * 两种情况都会给调用方一份与原文不符的内容，且看起来"读取成功"。
 *
 * 变异方式：删掉 `if (nextStart !== expectedNextStart) {...}` 整段
 * ⇒ 本文件前两条 ★ 用例必须红。
 */
import { describe, expect, it } from 'vitest';
import { callLocalFileReadAuto } from '../core/mcp/client';
import type { McpCallToolResult, McpProtocolTransport, McpServerConfig } from '../core/mcp/types';

function makeServer(): McpServerConfig {
  return {
    version: 1,
    id: 'file-read-67',
    displayName: 'file-read-67',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost: 'com.deepseek_pp.shell' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 1000, requestMs: 1000, discoveryMs: 1000 },
    limits: { maxResultBytes: 1_000_000, maxToolCount: 10 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as McpServerConfig;
}

interface WindowSpec {
  content: string;
  nextStart: number;
  totalChars: number;
  truncated: boolean;
  /** 宿主明确报告的已读码点数；不传则等于 content 的码点数 */
  charsRead?: number;
}

function windowResult(spec: WindowSpec): McpCallToolResult {
  return {
    content: [{ type: 'text', text: `Read ${spec.content.length} characters` }],
    structuredContent: {
      data: {
        path: '/x',
        content: spec.content,
        start: 0,
        nextStart: spec.nextStart,
        maxChars: spec.content.length,
        totalChars: spec.totalChars,
        charsRead: spec.charsRead ?? Array.from(spec.content).length,
        truncated: spec.truncated,
      },
    },
  } as unknown as McpCallToolResult;
}

function makeTransport(windows: McpCallToolResult[]): McpProtocolTransport {
  let index = 0;
  return {
    request: async () => {
      const result = windows[index] ?? windows[windows.length - 1];
      index += 1;
      return { jsonrpc: '2.0', id: 1, result } as unknown as Awaited<
        ReturnType<McpProtocolTransport['request']>
      >;
    },
  } as unknown as McpProtocolTransport;
}

const CALL = { name: 'local_file_read', payload: { path: '/x' } } as never;

describe('审计 #67：auto 续读窗口连续性', () => {
  it('★ gap（nextStart 越过本窗末尾）必须 fail-closed，不能静默漏字', async () => {
    const transport = makeTransport([
      windowResult({ content: 'AAAA', nextStart: 6, totalChars: 20, truncated: true }),
      windowResult({ content: 'BBBB', nextStart: 10, totalChars: 20, truncated: false }),
    ]);

    const result = await callLocalFileReadAuto(makeServer(), transport, { call: CALL } as never);

    expect(result.ok).toBe(false);
    expect(String(result.detail)).toContain('gap');
  });

  it('★ overlap（nextStart 落在本窗内部）必须 fail-closed，不能静默重复', async () => {
    const transport = makeTransport([
      windowResult({ content: 'AAAA', nextStart: 2, totalChars: 20, truncated: true }),
      windowResult({ content: 'BBBB', nextStart: 6, totalChars: 20, truncated: false }),
    ]);

    const result = await callLocalFileReadAuto(makeServer(), transport, { call: CALL } as never);

    expect(result.ok).toBe(false);
    expect(String(result.detail)).toContain('overlap');
  });

  it('负控：严格连续的两个窗口正常聚合（不能把正常路径堵死）', async () => {
    const transport = makeTransport([
      windowResult({ content: 'AAAA', nextStart: 4, totalChars: 8, truncated: true }),
      windowResult({ content: 'BBBB', nextStart: 8, totalChars: 8, truncated: false }),
    ]);

    const result = await callLocalFileReadAuto(makeServer(), transport, { call: CALL } as never);

    expect(result.ok).toBe(true);
    // 成功路径的 detail 是结构化 JSON（失败路径才是中文句子）
    const payload = JSON.parse(String(result.detail)) as {
      data?: { content?: string; windows?: number; charsReturned?: number };
    };
    expect(payload.data?.content).toBe('AAAABBBB');
    expect(payload.data?.windows).toBe(2);
    expect(payload.data?.charsReturned).toBe(8);
  });

  it('负控：以宿主 charsRead 为准，content 长度不同不算不连续', async () => {
    // 模拟宿主在 content 里附了额外字符（如截断标记）但 charsRead 只算真实读取量：
    // 期望下一窗起点 = 0 + 4 = 4，与实际 nextStart 一致 ⇒ 必须放行。
    const transport = makeTransport([
      windowResult({ content: 'AAAA', nextStart: 4, totalChars: 8, truncated: true, charsRead: 4 }),
      windowResult({ content: 'BBBB', nextStart: 8, totalChars: 8, truncated: false, charsRead: 4 }),
    ]);

    const result = await callLocalFileReadAuto(makeServer(), transport, { call: CALL } as never);

    expect(result.ok).toBe(true);
  });

  it('负控：nextStart 不前进仍按原有规则 fail-closed', async () => {
    const transport = makeTransport([
      windowResult({ content: 'AAAA', nextStart: 4, totalChars: 20, truncated: true }),
      windowResult({ content: 'BBBB', nextStart: 4, totalChars: 20, truncated: true }),
    ]);

    const result = await callLocalFileReadAuto(makeServer(), transport, { call: CALL } as never);

    expect(result.ok).toBe(false);
  });
});
