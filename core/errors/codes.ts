// W21: 错误码词表
// 纯数据表，不影响现有 code: 字符串

export type ErrorCategory = 'timeout' | 'cancel' | 'network' | 'protocol' | 'permission';

export const ERROR_CODES = {
  timeout_step:        { category: 'timeout',   retryable: true  },
  timeout_tool:        { category: 'timeout',   retryable: false },
  timeout_pow:         { category: 'timeout',   retryable: true  },
  cancel_user:         { category: 'cancel',    retryable: false },
  cancel_reset:        { category: 'cancel',    retryable: false },
  network_transport:   { category: 'network',   retryable: true  },
  network_unreadable:  { category: 'network',   retryable: true  },
  network_too_large:   { category: 'network',   retryable: false },
  protocol_bad_json:   { category: 'protocol',  retryable: false },
  protocol_no_frame:   { category: 'protocol',  retryable: true  },
  protocol_no_chain:   { category: 'protocol',  retryable: false },
  permission_denied:    { category: 'permission',retryable: false },
  permission_stale:    { category: 'permission',retryable: false },
} as const satisfies Record<string, { category: ErrorCategory; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;
