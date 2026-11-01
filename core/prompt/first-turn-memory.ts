/**
 * 首轮记忆注入策略（2026-11-01 收口 S2）。
 *
 * 实证（体检 A6，交错 AUG/NOAUG 6 对）：
 *   注入 13,612B 时「服务器暂时不可用」3/6；关掉注入（43B）时 0/6。
 *   报错轮 suppress/keepalive/retry 全为 0 ⇒ 与扣帧、重试无关，触发点是**首轮 prompt 体积**。
 * 体积构成：memory 8,378B + catalog 4,658B + base 576B。
 *
 * 策略：**首轮不注入记忆**（延迟到第二轮起），把首轮压到 ~5.2KB。
 * 回滚：`localStorage["dpp:firstTurnMemory"]="1"` 恢复旧行为（首轮也注入）。
 */

export const FIRST_TURN_MEMORY_RESTORE_KEY = "dpp:firstTurnMemory";

export interface DeferFirstTurnMemoryInput {
  /** 请求体里没有 parent_message_id。 */
  isFirstMessage: boolean;
  /** 用户/技能层面是否启用记忆。 */
  memoryEnabled: boolean;
  /** 是否存在可注入的记忆。 */
  hasMemories: boolean;
  /** 回滚开关是否被置为 "1"。 */
  restoreFlag: boolean;
}

/** 首轮是否应把记忆注入推迟到后续轮次。 */
export function shouldDeferFirstTurnMemory(input: DeferFirstTurnMemoryInput): boolean {
  if (input.restoreFlag) return false;
  if (!input.isFirstMessage) return false;
  if (!input.memoryEnabled) return false;
  return input.hasMemories;
}
