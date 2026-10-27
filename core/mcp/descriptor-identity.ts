/**
 * MCP descriptor 身份。
 *
 * 审计 #66（2026-10-24 报告 P1）：`createMcpInvocationName` 原本直接 `.slice(0, 96)`，
 * 两个不同的 (serverId, toolName) 组合只要**前 96 个字符相同**就会得到同一个
 * invocationName ⇒ 工具调用被路由到错误的 descriptor。
 *
 * 典型碰撞：serverId 很长（URL 派生 id），且两个工具名只在末尾不同。
 *
 * 修法：需要截断时保留前缀并**追加基于完整名的稳定短哈希**，
 * 做到「同输入同结果、异输入几乎必然不同」。
 */

const MAX_INVOCATION_NAME_LENGTH = 96;

export function createMcpDescriptorId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

export function createMcpInvocationName(serverId: string, toolName: string): string {
  const full = `mcp_${sanitizeMcpInvocationPart(serverId)}_${sanitizeMcpInvocationPart(toolName)}`;
  if (full.length <= MAX_INVOCATION_NAME_LENGTH) return full;

  const suffix = `_${fnv1aHex(full)}`;
  const keep = MAX_INVOCATION_NAME_LENGTH - suffix.length;
  return `${full.slice(0, keep)}${suffix}`;
}

function sanitizeMcpInvocationPart(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = normalized || 'tool';
  return /^[A-Za-z_]/.test(safe) ? safe : `t_${safe}`;
}

/** FNV-1a 32 位 → 8 位十六进制。同步、无依赖、跨运行稳定。 */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
