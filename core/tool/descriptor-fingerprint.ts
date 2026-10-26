// W27: 工具描述符变更检测
/**
 * @workitem W27
 * @status  deferred
 * @since   2026-10-19 (introduced by fd593c1)
 * @note    纯函数已交付并有用例；接线点：MCP 重连/工具重载后比对 fingerprint，变了才刷新工具列表（推断）
 */

export function fingerprintDescriptors(descriptors: Array<{ invocationName: string; name: string }>): string {
  const sorted = [...descriptors].sort((a, b) => a.invocationName.localeCompare(b.invocationName));
  return sorted.map(d => `${d.invocationName}:${d.name}`).join('|');
}

export function hasDescriptorChanged(oldHash: string, newHash: string): boolean {
  return oldHash !== newHash;
}
