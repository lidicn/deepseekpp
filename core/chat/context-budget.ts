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
  else if (ratio > 0.5) level = 'warn';
  return { level, remaining, estimatedTokens };
}
