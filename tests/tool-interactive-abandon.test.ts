/**
 * R04 交互型工具超时 abandoned 判定 shouldLogInteractiveAbandon 单测。
 * 零 IO：只验证「交互型 + tool_timeout 才记 abandoned」，诊断落盘在 runtime 宿主。
 * T39 已负责超时真正 abort provider；这里只决定是否额外记一条可见诊断。
 */
import { describe, expect, it } from 'vitest';
import {
  shouldLogInteractiveAbandon,
  TOOL_TIMEOUT_ERROR_CODE,
} from '../core/tool/runtime';

describe('R04 shouldLogInteractiveAbandon 交互型超时判定', () => {
  it('错误码常量等于 createToolTimeoutResult 的 tool_timeout', () => {
    expect(TOOL_TIMEOUT_ERROR_CODE).toBe('tool_timeout');
  });

  it('交互型 + tool_timeout → 记 abandoned', () => {
    expect(
      shouldLogInteractiveAbandon({
        isInteractive: true,
        errorCode: TOOL_TIMEOUT_ERROR_CODE,
      }),
    ).toBe(true);
  });

  it('交互型 + 其他错误码 → 不记（避免把普通失败误标 abandoned）', () => {
    expect(
      shouldLogInteractiveAbandon({
        isInteractive: true,
        errorCode: 'provider_error',
      }),
    ).toBe(false);
  });

  it('非交互型 + tool_timeout → 不记（长时/普通工具超时不走 abandoned）', () => {
    expect(
      shouldLogInteractiveAbandon({
        isInteractive: false,
        errorCode: TOOL_TIMEOUT_ERROR_CODE,
      }),
    ).toBe(false);
  });

  it('交互型 + 无错误码（成功/无 error）→ 不记', () => {
    expect(
      shouldLogInteractiveAbandon({ isInteractive: true, errorCode: undefined }),
    ).toBe(false);
  });
});
