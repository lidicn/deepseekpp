export class McpTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'McpTransportError';
    this.code = code;
    this.retryable = options?.retryable ?? true;
  }
}
