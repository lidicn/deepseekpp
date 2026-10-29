/**
 * 「空回答」分类（2026-10-30 真机发现）。
 *
 * 现象：新对话首条消息，DeepSeek 回了 FINISHED 帧、正文为空、只有思考块：
 *   `已思考（用时 1 秒）…先检查环境，然后浏览项目结构。让我开始。`
 * 之后 5 分钟不动。dpp 侧 `totalRequests=1`、无截断告警、agent loop 没启动
 * （因为没有任何工具调用），用户看到的就是一段"已思考…"。
 *
 * 这类轮次既不是断流（有 FINISHED），也不是正常完成（没有正文），
 * 必须在**聊天层**识别出来并给用户可见反馈，否则就是"什么都完不成"。
 */

export type EmptyAnswerVerdict = 'ok' | 'thinking-only' | 'empty';

export interface EmptyAnswerInput {
  /** 可见正文（不含思考）。 */
  answerText: string;
  /** 思考/推理文本（可空）。 */
  reasoningText?: string;
  /** 本轮是否有工具执行（有则属于工具轮，不该判成空回答）。 */
  hasToolExecutions?: boolean;
}

export function classifyEmptyAnswer(input: EmptyAnswerInput): EmptyAnswerVerdict {
  if (input.answerText.trim().length > 0) return 'ok';
  // 工具轮的空正文是正常的（模型在调工具，正文稍后才有）
  if (input.hasToolExecutions) return 'ok';
  return (input.reasoningText ?? '').trim().length > 0 ? 'thinking-only' : 'empty';
}

/** 是否值得给用户一条可见提示。 */
export function shouldWarnEmptyAnswer(verdict: EmptyAnswerVerdict): boolean {
  return verdict !== 'ok';
}
/**
 * 从页面读出「最后一条 assistant 消息的**正文**」。
 *
 * 为什么不能只看 payload.text：真机复现时 `complete.text` 里带着整段思考
 * （"已思考（用时 1 秒）…让我开始。"），于是 `answerText.trim()` 非空、
 * 被误判成 ok。用户看到的真相是"只有思考、没有正文"，
 * 所以判据必须读**渲染出来的正文容器**（`.ds-markdown`）。
 */
export function readLastAssistantAnswerText(root: ParentNode): string {
  const messages = root.querySelectorAll('.ds-message');
  const last = messages[messages.length - 1];
  if (!last) return '';
  const body = last.querySelector('.ds-markdown');
  return (body?.textContent ?? '').trim();
}

/** 页面上是否存在 assistant 消息（没有就退回用 payload 文本）。 */
export function hasAssistantMessage(root: ParentNode): boolean {
  return root.querySelectorAll('.ds-message').length > 0;
}