// W27: 工具描述符变更检测

export function fingerprintDescriptors(descriptors: Array<{ invocationName: string; name: string }>): string {
  const sorted = [...descriptors].sort((a, b) => a.invocationName.localeCompare(b.invocationName));
  return sorted.map(d => `${d.invocationName}:${d.name}`).join('|');
}

export function hasDescriptorChanged(oldHash: string, newHash: string): boolean {
  return oldHash !== newHash;
}
