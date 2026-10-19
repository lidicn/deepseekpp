// W22: 用户可读错误文案映射

export interface UserMessage {
  title: string;
  detail: string;
  action?: string;
}

export function toUserMessage(error: unknown): UserMessage {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('timeout') || msg.includes('abort')) {
    return { title: '请求超时', detail: '服务器响应过慢，请稍后重试。', action: '重试' };
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return { title: '网络错误', detail: '无法连接服务器，请检查网络。', action: '检查网络' };
  }
  if (msg.includes('permission') || msg.includes('denied')) {
    return { title: '权限不足', detail: '该操作需要授权，请重新登录。' };
  }
  return { title: '出错了', detail: msg, action: '重试' };
}
