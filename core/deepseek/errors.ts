export class DeepSeekAuthError extends Error {
  // D-09: 补 code/retryable，让上层可按错误码分流，而不是只靠 instanceof + 消息文本。
  readonly code = 'deepseek_auth' as const;
  readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekAuthError';
  }
}

export class DeepSeekPowError extends Error {
  readonly code = 'deepseek_pow' as const;
  // PoW 挑战失败是临时性的，重试（重算/重取挑战）通常有效。
  readonly retryable = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekPowError';
  }
}

export class DeepSeekSessionError extends Error {
  readonly code = 'deepseek_session' as const;
  readonly retryable = true as const;
  // 会话态错误时，请求是否已送达/已生效不确定，按 ambiguous 处理。
  readonly externalOutcome = 'ambiguous' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekSessionError';
  }
}

export class DeepSeekPayloadError extends Error {
  readonly code = 'deepseek_payload' as const;
  // payload 非法时请求尚未真正生效，按 not_started 处理。
  readonly externalOutcome = 'not_started' as const;
  readonly retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'DeepSeekPayloadError';
    this.retryable = options?.retryable ?? false;
  }
}
