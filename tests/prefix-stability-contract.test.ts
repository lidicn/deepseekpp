/**
 * v1.15 前缀稳定性 golden 测试（任务 1.6）
 *
 * 固化 P0-a（记忆块移位）的收益：连续两轮不同用户消息，
 * 渲染后的 prompt 最长公共前缀（LCP）字节数 / 总字节数 ≥ 90%。
 *
 * 这是 P0-a 收益的保险丝——今后任何改动只要破坏前缀稳定性，测试立即红。
 */
import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import { createMemoryToolDescriptors } from '../core/tool/memory';
import type { ToolDescriptor } from '../core/tool/types';

/** 构造代表性 Shell MCP 工具描述符（贴近生产 13 工具场景） */
function createShellMcpDescriptors(): ToolDescriptor[] {
  const provider = { kind: 'mcp' as const, id: 'shell-local', displayName: 'Shell Local', transport: 'native_messaging' as const };
  const base = { provider, execution: { mode: 'auto' as const, enabled: true, risk: 'low' as const } };
  const mk = (name: string, title: string, desc: string, props: Record<string, JsonValue>, required: string[]): ToolDescriptor => ({
    ...base,
    id: `mcp:shell-local:${name}`,
    name, invocationName: name, title, description: desc,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
  });
  return [
    mk('shell_exec', 'Execute Shell Command', 'Execute a shell command and return stdout, stderr, and exit code.',
      { command: { type: 'string', description: 'The shell command to execute.' }, cwd: { type: 'string', description: 'Working directory.' }, timeout: { type: 'integer', description: 'Timeout in ms.' } }, ['command']),
    mk('shell_status', 'Shell Status', 'Get status of a running shell command.',
      { command_id: { type: 'string', description: 'The command ID.' } }, ['command_id']),
    mk('python_exec', 'Execute Python', 'Execute Python code and return output.',
      { code: { type: 'string', description: 'Python code.' }, timeout: { type: 'integer', description: 'Timeout in ms.' } }, ['code']),
    mk('local_file_read', 'Read Local File', 'Read a file from the local filesystem.',
      { path: { type: 'string', description: 'Absolute path.' }, offset: { type: 'integer', description: 'Line offset.' }, limit: { type: 'integer', description: 'Max lines.' } }, ['path']),
    mk('local_file_stat', 'File Stat', 'Get file metadata.',
      { path: { type: 'string', description: 'Absolute path.' } }, ['path']),
  ];
}
import type { Memory, JsonValue } from '../core/types';

/** 计算两个字符串的最长公共前缀（LCP）的 UTF-8 字节数 */
function longestCommonPrefixBytes(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return new TextEncoder().encode(a.substring(0, i)).length;
}

const SAMPLE_MEMORIES: Memory[] = [
  {
    id: 1,
    syncId: 'sync-1',
    scope: 'global',
    type: 'user',
    name: '用户职业',
    content: '前端开发工程师，主要使用 React 和 TypeScript',
    description: '',
    tags: ['前端', 'React', 'TypeScript'],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
  },
  {
    id: 2,
    syncId: 'sync-2',
    scope: 'global',
    type: 'user',
    name: '饮品偏好',
    content: '喜欢喝美式咖啡、拿铁和无糖可乐',
    description: '',
    tags: ['饮品', '偏好'],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
  },
  {
    id: 3,
    syncId: 'sync-3',
    scope: 'global',
    type: 'topic',
    name: '项目技术栈',
    content: 'deepseek-pp 项目使用 TypeScript + WXT + React，浏览器扩展 MV3',
    description: '',
    tags: ['deepseek-pp', '技术栈'],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
  },
];

const ALL_TOOL_DESCRIPTORS = [...createMemoryToolDescriptors(), ...createShellMcpDescriptors()];

function buildTestPrompt(userMessage: string) {
  return buildPromptAugmentation(userMessage, {
    memories: SAMPLE_MEMORIES,
    thinkingEnabled: false,
    presetContent: null,
    projectContext: null,
    toolDescriptors: ALL_TOOL_DESCRIPTORS,
    locale: 'zh-CN',
    forceResponseLanguage: 'zh-CN',
  });
}

describe('prefix stability contract (P0-a regression guard)', () => {
  it('two different user messages share >= 90% prompt prefix by bytes', () => {
    const result1 = buildTestPrompt('你好，请介绍一下你自己。');
    const result2 = buildTestPrompt('今天天气怎么样？适合出去散步吗？');

    const prompt1 = result1.augmented;
    const prompt2 = result2.augmented;

    const lcpBytes = longestCommonPrefixBytes(prompt1, prompt2);
    const totalBytes = Math.max(
      new TextEncoder().encode(prompt1).length,
      new TextEncoder().encode(prompt2).length,
    );
    const prefixRate = (lcpBytes / totalBytes) * 100;

    // 诊断信息：测试失败时输出
    console.log(`[prefix-stability] LCP=${lcpBytes}B, total=${totalBytes}B, rate=${prefixRate.toFixed(1)}%`);
    console.log(`[prefix-stability] prompt1=${prompt1.length}chars, prompt2=${prompt2.length}chars`);

    // P0-a 后工具目录沉底为稳定前缀，记忆块在其后变化
    // 预期前缀一致率 ≥ 90%（工具目录 + 角色 + 工具格式说明占绝大部分）
    expect(prefixRate).toBeGreaterThanOrEqual(90);
  });

  it('prefix contains the tool catalog (tools before memories)', () => {
    const result = buildTestPrompt('测试消息');
    const prompt = result.augmented;

    const toolsIdx = prompt.indexOf('### Available Tools');
    const memoriesIdx = prompt.indexOf('## 已有记忆');

    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(memoriesIdx).toBeGreaterThanOrEqual(0);
    // P0-a 核心约束：工具目录必须在记忆块之前
    expect(toolsIdx).toBeLessThan(memoriesIdx);
  });

  it('identical messages produce byte-identical prompts (deterministic)', () => {
    const result1 = buildTestPrompt('完全相同的消息内容');
    const result2 = buildTestPrompt('完全相同的消息内容');

    expect(result1.augmented).toEqual(result2.augmented);
  });
});
