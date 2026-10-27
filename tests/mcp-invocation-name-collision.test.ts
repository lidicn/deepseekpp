/**
 * 审计 #66：`createMcpInvocationName` 截断到 96 字符时不得产生碰撞。
 *
 * 旧实现是 `.slice(0, 96)`：两个 (serverId, toolName) 只要前缀相同就得到同一个名字
 * ⇒ 工具调用被路由到错误的 descriptor。修复后在截断时追加基于完整名的稳定短哈希。
 *
 * 变异方式：把 `return \`${full.slice(0, keep)}${suffix}\`` 改回 `full.slice(0, 96)`
 * ⇒ 第一条「长名前缀相同但末尾不同」的用例必须红。
 */
import { describe, expect, it } from 'vitest';
import { createMcpInvocationName } from '../core/mcp/descriptor-identity';

const MAX = 96;

describe('审计 #66：invocationName 截断不碰撞', () => {
  it('★ 前缀相同、末尾不同的长名必须得到不同的 invocationName', () => {
    const longServer = 'srv_' + 'a'.repeat(80);
    const first = createMcpInvocationName(longServer, 'search_alpha');
    const second = createMcpInvocationName(longServer, 'search_beta');

    expect(first).not.toBe(second);
  });

  it('★ 同一输入必须稳定（哈希不能是随机的）', () => {
    const longServer = 'srv_' + 'b'.repeat(80);
    expect(createMcpInvocationName(longServer, 'x')).toBe(createMcpInvocationName(longServer, 'x'));
  });

  it('长度仍不超过 96，且仍是合法的工具名字符集', () => {
    const longServer = 'srv_' + 'c'.repeat(120);
    const name = createMcpInvocationName(longServer, 'y'.repeat(60));
    expect(name.length).toBeLessThanOrEqual(MAX);
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('负控：不需要截断的名字保持原样（不引入哈希，向后兼容）', () => {
    expect(createMcpInvocationName('short', 'echo')).toBe('mcp_short_echo');
  });
});
