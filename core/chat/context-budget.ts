// W25: 会话级上下文预算

export type BudgetLevel = 'ok' | 'warn' | 'critical';

export interface BudgetState {
  level: BudgetLevel;
  remaining: number;
  estimatedTokens: number;
}

export function evaluateBudget(
  messageCount: number,
  estimatedTokens: number,
  limit: number,
): BudgetState {
  const ratio = estimatedTokens / limit;
  const remaining = limit - estimatedTokens;
  let level: BudgetLevel = 'ok';
  if (ratio > 0.8) level = 'critical';
  else if (ratio >= 0.5) level = 'warn';
  return { level, remaining, estimatedTokens };
}

/**
 * R06 经验占位上限（64k）。非某一模型的精确窗口，仅用于本地粗估的三档可见化；
 * 精确 token 计数待后续 tokenizer/服务端 usage 管线。
 */
export const CHAT_CONTEXT_TOKEN_LIMIT = 64_000;

const CJK_RE = /[一-鿿　-〿＀-￯]/;

/**
 * R06 本地长度粗估 token：CJK 全角每字约 1，其余 ASCII 每 4 字符约 1。
 * 非服务端精确计数，仅用于预算档位提示，不用于截断决策。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 4);
}

/** 把一段待估算文本过粗估后交给 evaluateBudget，返回三档快照。 */
export function evaluateBudgetForText(
  text: string,
  limit: number = CHAT_CONTEXT_TOKEN_LIMIT,
): BudgetState {
  return evaluateBudget(0, estimateTextTokens(text), limit);
}
