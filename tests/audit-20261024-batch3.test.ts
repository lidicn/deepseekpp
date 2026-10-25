// 审计报告《deepseek-pp-审计报告.md》（2026-10-24，100 条）第三批修复的守护用例。
//
// 本批 6 条：
//   #1  resume-tool-loop 的 toolResultsText 不随内层工具执行刷新（续跑丢上下文）
//   #10 request-policy 对 Blob/FormData/ArrayBuffer 不做大小上限（OOM 面）
//   #17 SSE POST 响应体未消费也未取消（连接池泄漏）
//   #18 SSE reader 在 POST 失败时未 cancel（流泄漏）
//   #20 多个 bearer/basic 秘密互相覆盖 Authorization
//   #21 mergeRedactedSecrets 多/零 metadata 匹配时静默丢密钥
//
// 说明：#1 / #20 / #21 走**行为断言**；#10 的用例在 request-policy-boundary.test.ts；
// #17 / #18 的 sse 传输需要完整服务器配置 + fetch 打桩，这里用**结构断言**守关键语句。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/inline-agent/step-control', () => ({
  waitBetweenDeepSeekRequests: vi.fn(async () => {}),
}));

import { runResumeToolLoop } from '../core/chat/resume-tool-loop';
import type { ResumeToolLoopDeps } from '../core/chat/resume-tool-loop';
import type { ActiveChatLoop } from '../core/chat/active-loop';
import type { ToolJob } from '../core/tool/job';
import type { ToolCall } from '../core/tool/types';
import { buildMcpRequestHeaders, mergeRedactedSecrets } from '../core/mcp/store';
import type { McpSecretValue, McpServerConfig } from '../core/mcp/types';

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

function makeJob(overrides: Partial<ToolJob> = {}): ToolJob {
  return {
    id: 'test-job', turnId: 'test-turn', parentMessageId: 12345,
    calls: [], executions: [], position: { callIndex: 0, depth: 0 },
    state: 'interrupted', startedAt: Date.now(),
    ...overrides,
  } as unknown as ToolJob;
}

function makeSnapshot(overrides: Partial<ActiveChatLoop> = {}): ActiveChatLoop {
  return {
    schemaVersion: 1, provider: 'web', jobId: 'test-job', turnId: 'test-turn',
    parentMessageId: 12345, chatSessionId: 'test-session', calls: [], executions: [],
    position: { callIndex: 0, depth: 0 }, attempt: 0, startedAt: Date.now(),
    ...overrides,
  } as unknown as ActiveChatLoop;
}

describe('审计 #1：续轮请求必须带上上一轮刚跑完的工具结果', () => {
  it('第二次 submitContinuation 的 toolResults 含第一次执行的结果（修复前为空）', async () => {
    const submitted: string[] = [];
    let round = 0;
    const deps: ResumeToolLoopDeps = {
      executeToolCall: async (call: ToolCall) => ({
        name: call.name,
        result: { ok: true, summary: 'RESULT_MARKER_42' },
      }),
      submitContinuation: async (input: { toolResults?: unknown }) => {
        submitted.push(String(input.toolResults ?? ''));
        round += 1;
        if (round === 1) {
          // 第一轮：让模型再调一个工具，逼迫进入第二轮
          return {
            responseMessageId: '1', assistantText: '', finished: false,
            toolCalls: [{ name: 'memory_save', args: {} }],
          } as never;
        }
        return {
          responseMessageId: '2', assistantText: 'done', finished: true, toolCalls: [],
        } as never;
      },
      broadcastChunk: () => {},
      finalize: async () => {},
      updateMarker: async () => {},
    } as unknown as ResumeToolLoopDeps;

    await runResumeToolLoop(
      { job: makeJob(), snapshot: makeSnapshot(), resumeIndex: 0, depth: 0 },
      deps,
      new AbortController().signal,
    );

    expect(submitted.length).toBeGreaterThanOrEqual(2);
    // 关键断言：第一轮请求里不可能有第一轮执行结果；第二轮必须有
    expect(submitted[1]).toContain('RESULT_MARKER_42');
  });
});

describe('审计 #20：多个 Authorization 来源不得静默互相覆盖', () => {
  function server(secrets: McpSecretValue[]): McpServerConfig {
    return {
      id: 'server-1', headers: [], secrets,
      transport: { kind: 'http', url: 'https://a.example/mcp' },
    } as unknown as McpServerConfig;
  }

  it('两个 bearer：只采用第一个，不静默覆盖', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const headers = buildMcpRequestHeaders(server([
      { kind: 'bearer', value: 'first-key' },
      { kind: 'bearer', value: 'second-key' },
    ]));
    expect(headers.Authorization).toBe('Bearer first-key');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('bearer + basic 混用：同样只采用第一个并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const headers = buildMcpRequestHeaders(server([
      { kind: 'bearer', value: 'b-key' },
      { kind: 'basic', value: 'basic-key' },
    ]));
    expect(headers.Authorization).toBe('Bearer b-key');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('单个 bearer 正常生效、不告警（负控）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const headers = buildMcpRequestHeaders(server([{ kind: 'bearer', value: 'k' }]));
    expect(headers.Authorization).toBe('Bearer k');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('header 类秘密仍按 headerName 写入（负控：别把 header 秘密当 Authorization）', () => {
    const headers = buildMcpRequestHeaders(server([
      { kind: 'header', headerName: 'X-Tenant', value: 't1' },
    ]));
    expect(headers['X-Tenant']).toBe('t1');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('审计 #21：脱敏秘密匹配失败不得静默清空', () => {
  // 与 core/mcp/store.ts 的 REDACTED_SECRET_VALUE 保持一致（该常量未导出）
  const REDACTED = '********';

  it('按 id 匹配成功 ⇒ 恢复原值', () => {
    const merged = mergeRedactedSecrets(
      [{ id: 'sec-1', kind: 'bearer', value: 'real-key' }],
      [{ id: 'sec-1', kind: 'bearer', value: REDACTED }],
    );
    expect(merged[0]?.value).toBe('real-key');
  });

  it('元数据唯一匹配 ⇒ 恢复原值（id 变了也能救回来）', () => {
    const merged = mergeRedactedSecrets(
      [{ id: 'old-id', kind: 'header', headerName: 'X-Key', value: 'real' }],
      [{ id: 'new-id', kind: 'header', headerName: 'X-Key', value: REDACTED }],
    );
    expect(merged[0]?.value).toBe('real');
  });

  it('元数据匹配到 2 条（有歧义）⇒ 按列表位置兜底，仍能恢复', () => {
    const previous: McpSecretValue[] = [
      { id: 'a', kind: 'header', headerName: 'X-Key', value: 'value-a' },
      { id: 'b', kind: 'header', headerName: 'X-Key', value: 'value-b' },
    ];
    const merged = mergeRedactedSecrets(previous, [
      { id: 'x', kind: 'header', headerName: 'X-Key', value: REDACTED },
      { id: 'y', kind: 'header', headerName: 'X-Key', value: REDACTED },
    ]);
    expect(merged.map((s) => s.value)).toEqual(['value-a', 'value-b']);
  });

  it('实在匹配不上 ⇒ 清空但**必须告警**（不能静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const merged = mergeRedactedSecrets(
      [{ id: 'a', kind: 'header', headerName: 'X-Old', value: 'v' }],
      [{ id: 'b', kind: 'header', headerName: 'X-New', value: REDACTED }],
    );
    expect(merged[0]?.value).toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('明文新值原样保留（负控：不要覆盖用户刚填的密钥）', () => {
    const merged = mergeRedactedSecrets(
      [{ id: 'a', kind: 'bearer', value: 'old' }],
      [{ id: 'a', kind: 'bearer', value: 'brand-new' }],
    );
    expect(merged[0]?.value).toBe('brand-new');
  });
});

describe('审计 #17 / #18：SSE 连接不得泄漏', () => {
  const source = readSource('core/mcp/transports/sse.ts');

  it('#17 POST 响应体必须被消费或取消（失败与成功两条路径都要）', () => {
    // 失败分支：throw 之前先 cancel
    expect(source).toMatch(/if \(!response\.ok\) \{[\s\S]{0,300}?response\.body\?\.cancel\(\)/);
    // 成功分支：函数结束前也必须 cancel（MCP SSE 的 POST 响应体是空体/ACK）
    const postFn = source.slice(source.indexOf('async function postSseMessage'));
    const body = postFn.slice(0, postFn.indexOf('\n}\n'));
    const cancelCount = (body.match(/body\?\.cancel\(\)/g) ?? []).length;
    expect(cancelCount).toBeGreaterThanOrEqual(2);
  });

  it('#18 POST 失败时必须 cancel reader', () => {
    // 必须精确匹配 catch 块内部 —— 只用 `reader.cancel()` 做宽匹配会被后面
    // 通知分支的同名调用蒙过去（第一版断言就是这么漏的，变异验证红 0 才抓到）。
    expect(source).toMatch(
      /\} catch \(error\) \{\s*await reader\.cancel\(\)\.catch\(\(\) => undefined\);\s*throw error;\s*\}/,
    );
  });
});
