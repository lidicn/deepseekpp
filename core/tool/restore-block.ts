export interface ToolRestoreBlockIdentity {
  requestId?: string | null;
  chatSessionId?: string | null;
  parentMessageId?: number | null;
  fallbackUrl: string;
  fallbackSeed?: string | null;
}

export interface ToolRestoreBlockUrlInput {
  origin: string;
  pathname: string;
  search?: string;
  chatSessionId?: string | null;
}

export function createToolRestoreBlockId(identity: ToolRestoreBlockIdentity): string {
  if (identity.requestId) {
    return `request:${hashString(identity.requestId)}`;
  }

  if (identity.chatSessionId) {
    return `chat:${hashString(`${identity.chatSessionId}\n${identity.parentMessageId ?? ''}`)}`;
  }

  return `route:${hashString(`${identity.fallbackUrl}\n${identity.fallbackSeed ?? ''}`)}`;
}

/**
 * 按优先级列出**所有可能命中**的 id 候选（去重、保序）。
 *
 * 2026-10-22：`createToolRestoreBlockId` 是单值、按优先级只走一条分支，
 * 而创建侧（工具调用）与完成侧（RESPONSE_COMPLETE）拿到的字段并不一致：
 *   - 创建侧：requestId = call.source?.requestId，parentMessageId 取调用时值
 *   - 完成侧：requestId = complete.requestId，parentMessageId = complete.parentMessageId
 * 只要完成侧 requestId 为空、或 parentMessageId 与调用时不同，两边就会落进
 * 不同分支，单值查找必然 miss → completedExecutions 变空 → agent 不启动。
 *
 * 真机证据：工具执行成功（SW 诊断 ok），但埋点 executions=0。
 *
 * 这里把三条分支的候选都列出来，让查找方依次尝试。
 */
export function createToolRestoreBlockIdCandidates(
  identity: ToolRestoreBlockIdentity,
): string[] {
  const candidates: string[] = [];
  const push = (id: string) => {
    if (!candidates.includes(id)) candidates.push(id);
  };

  if (identity.requestId) {
    push(`request:${hashString(identity.requestId)}`);
  }
  if (identity.chatSessionId) {
    push(`chat:${hashString(`${identity.chatSessionId}\n${identity.parentMessageId ?? ''}`)}`);
    // 完成侧的 parentMessageId 可能尚未同步，补一条不带 parentMessageId 的候选。
    push(`chat:${hashString(`${identity.chatSessionId}\n`)}`);
  }
  push(`route:${hashString(`${identity.fallbackUrl}\n${identity.fallbackSeed ?? ''}`)}`);
  return candidates;
}

export function createToolRestoreBlockUrl(input: ToolRestoreBlockUrlInput): string {
  if (!input.chatSessionId) {
    return `${input.origin}${input.pathname}${input.search ?? ''}`;
  }

  const prefix = input.pathname.startsWith('/chat/s/') ? '/chat/s/' : '/a/chat/s/';
  return `${input.origin}${prefix}${encodeURIComponent(input.chatSessionId)}`;
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
