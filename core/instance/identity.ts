/**
 * W36 多上下文实例标识（纯函数，零 IO）。
 *
 * 背景：main-world / content / background / sidepanel 四个上下文可能各跑一份状态，
 * 诊断快照需要「这条记录来自哪个上下文、什么时候启动、实例唯一 id」，便于事后对账。
 * 本模块只生成标识，不做跨上下文自动同步（规格边界）。
 */
/**
 * @workitem W36
 * @status  deferred
 * @since   2026-10-20 (introduced by 5224286)
 * @note    纯函数已交付并有用例；接线点：诊断快照/boot-health 记录当前 ContextName + 实例 id 以便跨上下文对账（推断）
 */

export type ContextName = 'main-world' | 'content' | 'background' | 'sidepanel';

export const CONTEXT_NAMES: readonly ContextName[] = [
  'main-world',
  'content',
  'background',
  'sidepanel',
];

export interface InstanceIdentity {
  /** 来源上下文。 */
  context: ContextName;
  /** 实例启动时刻（epoch ms），可注入以便测试。 */
  startedAt: number;
  /** 实例唯一标识。 */
  instanceId: string;
}

function isContextName(value: unknown): value is ContextName {
  return typeof value === 'string' && (CONTEXT_NAMES as readonly string[]).includes(value);
}

function generateInstanceId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoLike?.randomUUID === 'function') return cryptoLike.randomUUID();
  // 退化兜底：无 randomUUID 环境下用随机串（仅保证本次运行内唯一，不追求全局）。
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 创建实例标识。`now` 可注入（测试用），缺省取当前时间；非法 context 抛错，
 * 不静默落到默认值。
 */
export function createInstanceIdentity(
  context: unknown,
  now: number = Date.now(),
): InstanceIdentity {
  if (!isContextName(context)) {
    throw new Error(`createInstanceIdentity: 未知上下文 "${String(context)}"`);
  }
  return {
    context,
    startedAt: now,
    instanceId: generateInstanceId(),
  };
}
