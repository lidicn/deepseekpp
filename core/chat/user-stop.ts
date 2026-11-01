/**
 * 用户主动停止（点「停止」）的终态识别（t3-C，2026-11-01）。
 *
 * 现场（t1 实测，2026-11-01 19:52–20:09）：
 * - DeepSeek 生成中，composer 的发送按钮会从纸飞机变成方块（class 不变）：
 *   `.ds-button--primary.ds-button--filled`（全页唯一，34×34，无 aria/title/stop 类名）。
 * - 点它之后：服务端以 EOF 收尾（**没有 FINISHED 帧**）⇒ `truncated=true`，
 *   扩展的 `empty_answer_auto_continue` 判据只看到「truncated + 没有工具执行」，
 *   于是**自动再发一条 completion**（实测 374B payload），把追问当新问题回答。
 * - 这是「点停止 → 自动续轮 → 怪答案」的链路：用户已经喊停，扩展不该替他续。
 *
 * 本模块只做两件事（都可单测）：
 * 1. 从 DOM 点击里认出「点的是停止态按钮」（图标 path 前缀 `M2 4.88` 是停止方块，
 *    发送态是 `M8.3125`）；
 * 2. 一个带 TTL 的一次性标记：`noteStop()` 记下，`consume()` 只在「该停止确实
 *    对应某次完成回调」时消费一次 —— 不影响下一次真正的空回答续跑。
 */

/** 停止/发送共用的那颗按钮（t1 实测：全页唯一）。 */
export const USER_STOP_BUTTON_SELECTOR = '.ds-button--primary.ds-button--filled';
/** 停止态图标 path 前缀（方块）；发送态是 `M8.3125`（纸飞机）。 */
export const USER_STOP_ICON_PATH_PREFIX = 'M2 4.88';
/** 标记有效期：点停止后对应的 completion 通常 1–2s 内到；给足余量但不跨轮。 */
export const USER_STOP_TTL_MS = 30_000;

export interface UserStopTracker {
  /** 记一次用户停止（默认取当前时间）。 */
  noteStop(now?: number): void;
  /** 是否有未消费且未过期的停止标记。 */
  peek(now?: number): boolean;
  /** 消费一次停止标记：有则返回 true 并清除（一次停止只挡一次自动续跑）。 */
  consume(now?: number): boolean;
  clear(): void;
}

export function createUserStopTracker(ttlMs: number = USER_STOP_TTL_MS): UserStopTracker {
  let stoppedAt: number | null = null;

  const isFresh = (now: number): boolean => {
    if (stoppedAt === null) return false;
    const age = now - stoppedAt;
    if (age < 0 || age > ttlMs) {
      stoppedAt = null;
      return false;
    }
    return true;
  };

  return {
    noteStop(now = Date.now()) {
      stoppedAt = now;
    },
    peek(now = Date.now()) {
      return isFresh(now);
    },
    consume(now = Date.now()) {
      if (!isFresh(now)) return false;
      stoppedAt = null;
      return true;
    },
    clear() {
      stoppedAt = null;
    },
  };
}

/**
 * 点击目标是否是「停止态」的 composer 按钮。
 *
 * 只看两个事实：命中唯一 selector + 当前 svg path 是停止方块。
 * 不依赖 aria/title/class 里的 "stop" 字样（真机上都没有，按那些找 hit=0）。
 */
export function isStopControlTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  const button = element.closest(USER_STOP_BUTTON_SELECTOR);
  if (!button) return false;
  const path = button.querySelector('svg path');
  const data = path?.getAttribute('d') ?? '';
  return data.startsWith(USER_STOP_ICON_PATH_PREFIX);
}

/** 安装 document 级捕获监听；返回卸载函数（供 content capability cleanup 使用）。 */
export function installUserStopClickListener(
  doc: Document,
  onStop: () => void,
): () => void {
  const handler = (event: Event): void => {
    if (isStopControlTarget(event.target)) onStop();
  };
  doc.addEventListener('click', handler, true);
  return () => doc.removeEventListener('click', handler, true);
}
