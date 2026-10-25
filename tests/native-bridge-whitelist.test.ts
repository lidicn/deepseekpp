/**
 * 审计 #28：native bridge 对 commandType 加白名单。
 *
 * port.onMessage 收到 msg.commandType 后不能直接当 envelope.type——native host 可触发任意
 * runtime 命令。这里：
 *  1) 行为断言：dpp-bridge.mjs 实际会发的 8 个命令全部在白名单内；高危/任意命令不在；
 *  2) 结构断言：background.ts 的 listener 确实在构造 envelope 前用白名单拦截并 console.warn。
 *
 * 变异验证：删掉 background.ts 里的 `if (!NATIVE_BRIDGE_ALLOWED_COMMANDS.has(...))` ⇒ 结构断言红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_BRIDGE_ALLOWED_COMMANDS } from '../core/messaging/runtime-boundary';

describe('#28 native bridge commandType 白名单', () => {
  it('放行 dpp-bridge.mjs 实际路由的 8 个命令', () => {
    for (const cmd of [
      'GET_MEMORIES',
      'PARSE_NATURAL_LANGUAGE_MEMORY',
      'APPLY_MEMORY_ORGANIZE_DRAFT',
      'SAVE_MEMORY',
      'DELETE_MEMORY',
      'GET_AUTOMATIONS',
      'CREATE_AUTOMATION',
      'RUN_AUTOMATION_NOW',
    ]) {
      expect(NATIVE_BRIDGE_ALLOWED_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('不放行高危/任意命令（native host 不得触发任意 runtime 命令）', () => {
    for (const cmd of [
      'EXECUTE_TOOL_CALL',
      'GET_BACKGROUND',
      'OPEN_TAB',
      'RECORD_USAGE_TURN',
      'DELETE_ALL_DATA',
      'EVAL',
      'CHAT',
    ]) {
      expect(NATIVE_BRIDGE_ALLOWED_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it('background.ts listener 在构造 envelope 前用白名单拦截并告警', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/background.ts'), 'utf8');
    // 拦截必须在 envelope 构造之前
    const gate = "if (!NATIVE_BRIDGE_ALLOWED_COMMANDS.has(msg.commandType as string))";
    expect(source).toContain(gate);
    expect(source).toContain("console.warn('[dpp-bridge] 拒绝未授权的 commandType:'");
    // 顺序：拦截 return 必须出现在 envelope 构造之前（同一段 listener 内）
    const gateIdx = source.indexOf(gate);
    const envelopeIdx = source.indexOf('type: msg.commandType,');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(envelopeIdx).toBeGreaterThan(gateIdx);
  });
});
