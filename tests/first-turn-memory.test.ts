import { describe, expect, it } from 'vitest';
import { shouldDeferFirstTurnMemory } from '../core/prompt/first-turn-memory';

describe('首轮记忆注入策略（收口 S2）', () => {
  const base = { isFirstMessage: true, memoryEnabled: true, hasMemories: true, restoreFlag: false };

  it('★★ 首轮 + 有记忆 ⇒ 推迟（把首轮 prompt 从 13.6KB 压到 ~5.2KB）', () => {
    expect(shouldDeferFirstTurnMemory(base)).toBe(true);
  });

  it('★ 非首轮 ⇒ 不推迟（正常注入）', () => {
    expect(shouldDeferFirstTurnMemory({ ...base, isFirstMessage: false })).toBe(false);
  });

  it('★ 回滚开关置 1 ⇒ 恢复旧行为', () => {
    expect(shouldDeferFirstTurnMemory({ ...base, restoreFlag: true })).toBe(false);
  });

  it('负控：没启用记忆 / 没有记忆 ⇒ 无需推迟', () => {
    expect(shouldDeferFirstTurnMemory({ ...base, memoryEnabled: false })).toBe(false);
    expect(shouldDeferFirstTurnMemory({ ...base, hasMemories: false })).toBe(false);
  });
});
