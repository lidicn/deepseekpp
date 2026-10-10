/**
 * Memory Extractor — Phase 1
 *
 * 规则提取器：从对话轮次中自动识别强信号，生成记忆候选。
 * 不依赖 LLM，纯规则触发。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §提取
 */

export type SignalType =
  | 'correction'
  | 'preference'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'procedure'
  | 'goal'
  | 'noise';

export type MemoryKind =
  | 'user'        // 用户画像/偏好
  | 'feedback'    // 反馈/纠正
  | 'topic'       // 项目/主题
  | 'reference'; // 事实/引用

export interface ExtractionSignal {
  type: SignalType;
  /** 命中片段（用于 quote） */
  span?: string;
  /** 0~1，规则置信度 */
  confidence: number;
}

export interface ExtractionCandidate {
  kind: MemoryKind;
  content: string;
  normalized: string;
  dedupeKey: string;
  importance: 0 | 1 | 2 | 3;
  tags: string[];
  signals: ExtractionSignal[];
  tokens: number;
}

export type ExtractionGateReason =
  | 'signal'
  | 'session_end'
  | 'manual'
  | 'idle_timeout'
  | 'threshold_not_met'
  | 'cooldown'
  | 'noise_only'
  | 'too_long'
  | 'auto_continue_round'
  | 'policy';

export interface ExtractionGateResult {
  trigger: boolean;
  reason: ExtractionGateReason;
  signals: ExtractionSignal[];
}

/**
 * 强信号词表（中文）。
 * 每个信号类型对应一组触发词，命中即生成 ExtractionSignal。
 */
const STRONG_SIGNAL_PATTERNS: Record<SignalType, RegExp> = {
  correction: /(不对|错了|不是|重来|修正|改一下|别这样|不应该)/,
  preference: /(喜欢|偏好|习惯|常用|不要|讨厌|更倾向|优先)/,
  constraint: /(必须|禁止|不能|要求|约束|确保|一定|不准)/,
  decision: /(决定|就这么定了|选定|采用|最终|拍板|确定)/,
  fact: /(项目是|目录在|路径在|地址是|版本是|链接是|名字叫)/,
  procedure: /(第一步|流程是|步骤|怎么操作|怎么做|操作方式)/,
  goal: /(目标是|要完成|计划|下一步|最终目的|希望)/,
  noise: /(谢谢|好的|收到|明白了|继续|嗯|哦)/,
};

/**
 * 弱信号词表（置信度较低，需要两个以上才触发）。
 */
const WEAK_SIGNAL_PATTERNS: Record<SignalType, RegExp> = {
  correction: /(好像|可能|也许)/,
  preference: /(觉得|感觉|认为)/,
  constraint: /(尽量|尽可能)/,
  decision: /(打算|准备|考虑)/,
  fact: /(大概|大约|差不多)/,
  procedure: /(试试|看看)/,
  goal: /(希望|想)/,
  noise: /(哈哈|嗯)/,
};

/**
 * 门控配置。
 */
export interface ExtractionGateConfig {
  /** 最少轮数（turn ≥ 此值才考虑提取） */
  minTurns: number;
  /** 强信号最少命中数 */
  minStrongSignals: number;
  /** 弱信号最少命中数（强信号不足时用） */
  minWeakSignals: number;
  /** 冷却轮数（距上次提取多少轮后才能再次提取） */
  cooldownTurns: number;
  /** 最大 token 数（超过则不提取） */
  maxTokens: number;
}

export const DEFAULT_GATE_CONFIG: ExtractionGateConfig = {
  minTurns: 2,
  minStrongSignals: 1,
  minWeakSignals: 2,
  cooldownTurns: 5,
  maxTokens: 200,
};

/**
 * 估算 token 数（粗略：中文按字符数/1.5，英文按单词数）。
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  return Math.ceil(chineseChars / 1.5 + englishWords);
}

/**
 * 从文本中提取信号。
 */
export function extractSignals(text: string): ExtractionSignal[] {
  const signals: ExtractionSignal[] = [];

  for (const [type, pattern] of Object.entries(STRONG_SIGNAL_PATTERNS)) {
    const match = text.match(pattern);
    if (match) {
      signals.push({
        type: type as SignalType,
        span: match[0],
        confidence: 0.8,
      });
    }
  }

  for (const [type, pattern] of Object.entries(WEAK_SIGNAL_PATTERNS)) {
    const match = text.match(pattern);
    if (match) {
      signals.push({
        type: type as SignalType,
        span: match[0],
        confidence: 0.4,
      });
    }
  }

  return signals;
}

/**
 * 门控判断：当前轮次是否应该触发提取。
 */
export function evaluateGate(
  turnCount: number,
  lastExtractionTurn: number | null,
  signals: ExtractionSignal[],
  config: ExtractionGateConfig = DEFAULT_GATE_CONFIG,
): ExtractionGateResult {
  // 轮数不够
  if (turnCount < config.minTurns) {
    return { trigger: false, reason: 'threshold_not_met', signals };
  }

  // 冷却中
  if (lastExtractionTurn !== null && turnCount - lastExtractionTurn < config.cooldownTurns) {
    return { trigger: false, reason: 'cooldown', signals };
  }

  // 只有噪音信号
  const realSignals = signals.filter((s) => s.type !== 'noise');
  if (realSignals.length === 0) {
    return { trigger: false, reason: 'noise_only', signals };
  }

  // 强信号不足，且弱信号也不够
  const strongCount = realSignals.filter((s) => s.confidence >= 0.7).length;
  const weakCount = realSignals.filter((s) => s.confidence < 0.7).length;
  if (strongCount < config.minStrongSignals && weakCount < config.minWeakSignals) {
    return { trigger: false, reason: 'threshold_not_met', signals };
  }

  return { trigger: true, reason: 'signal', signals };
}

/**
 * 从信号生成记忆候选。
 */
export function buildCandidate(
  text: string,
  signals: ExtractionSignal[],
): ExtractionCandidate | null {
  const realSignals = signals.filter((s) => s.type !== 'noise');
  if (realSignals.length === 0) return null;

  // 根据主信号类型决定记忆 kind
  const mainSignal = realSignals[0];
  let kind: MemoryKind = 'user';
  let importance: 0 | 1 | 2 | 3 = 1;
  const tags: string[] = [];

  switch (mainSignal.type) {
    case 'correction':
      kind = 'feedback';
      importance = 2;
      tags.push('correction');
      break;
    case 'preference':
      kind = 'user';
      importance = 2;
      tags.push('preference');
      break;
    case 'constraint':
      kind = 'topic';
      importance = 2;
      tags.push('constraint');
      break;
    case 'decision':
      kind = 'topic';
      importance = 3;
      tags.push('decision');
      break;
    case 'fact':
      kind = 'reference';
      importance = 1;
      tags.push('fact');
      break;
    case 'procedure':
      kind = 'topic';
      importance = 1;
      tags.push('procedure');
      break;
    case 'goal':
      kind = 'topic';
      importance = 2;
      tags.push('goal');
      break;
    default:
      kind = 'user';
      importance = 0;
  }

  // 归一化文本（去除前后空白、压缩多余空格）
  const normalized = text.trim().replace(/\s+/g, ' ').slice(0, 200);
  const tokens = estimateTokens(normalized);

  // 去重 key：取前 50 字符的 hash
  const dedupeKey = normalized.slice(0, 50);

  return {
    kind,
    content: normalized,
    normalized,
    dedupeKey,
    importance,
    tags,
    signals: realSignals,
    tokens,
  };
}
