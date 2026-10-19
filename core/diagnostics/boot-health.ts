// T32: 启动自检纯函数

export interface BootHealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  suggestion?: string;
}

export interface BootHealthDeps {
  runtimeId: string | undefined;
  storedVersion: string | null;
  currentVersion: string;
  hasAuthToken: boolean;
  registeredProviderCount: number;
  mcpStatus: 'connected' | 'unconfigured' | 'failed';
  keepaliveAlive: boolean;
}

export function runBootHealth(deps: BootHealthDeps): BootHealthCheck[] {
  return [
    { name: 'runtime', ok: !!deps.runtimeId, detail: deps.runtimeId ?? 'missing', suggestion: '重新加载扩展' },
    { name: 'version', ok: deps.storedVersion === deps.currentVersion, detail: `${deps.storedVersion} vs ${deps.currentVersion}`, suggestion: '扩展已更新，请刷新页面' },
    { name: 'auth', ok: deps.hasAuthToken, detail: deps.hasAuthToken ? 'ok' : 'missing', suggestion: '请先登录 chat.deepseek.com' },
    { name: 'tools', ok: deps.registeredProviderCount > 0, detail: String(deps.registeredProviderCount), suggestion: '检查工具配置' },
    { name: 'mcp', ok: deps.mcpStatus !== 'failed', detail: deps.mcpStatus, suggestion: deps.mcpStatus === 'failed' ? '检查 MCP 服务' : undefined },
    { name: 'keepalive', ok: deps.keepaliveAlive, detail: deps.keepaliveAlive ? 'alive' : 'dead', suggestion: '长任务可能被中断' },
  ];
}
