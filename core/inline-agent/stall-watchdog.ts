/**
 * 页面侧看门狗的 DOM 读取（2026-10-30）。
 *
 * 抽成独立函数的原因：第一版直接写在 `content.ts` 里用
 * `document.querySelector(".ds-message:last-of-type .ds-markdown")`，
 * 结果：
 *   - `:last-of-type` 按**标签类型**匹配，容器后面还有别的 div 时匹配不到
 *   - 退化分支取的是**第一条** `.ds-message`（通常是用户消息）⇒ 长度恒定
 *     ⇒ 180 秒后必定触发，把正常生成当"挂死"点掉
 *
 * 所以这里显式取"最后一条消息"，并用单测把它钉住。
 */

export const MESSAGE_SELECTOR = '.ds-message';
export const ANSWER_SELECTOR = '.ds-markdown';

/** 最后一条助手消息的正文长度（找不到则 0）。 */
export function readLastAnswerLength(root: ParentNode): number {
  const messages = root.querySelectorAll(MESSAGE_SELECTOR);
  if (messages.length === 0) return 0;
  const last = messages[messages.length - 1];
  const markdown = last.querySelector(ANSWER_SELECTOR);
  return (markdown?.textContent ?? '').trim().length;
}
