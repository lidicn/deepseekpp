export type PromptTextInsertionResult =
  | { ok: true; insertedLength: number }
  | { ok: false; error: 'empty_prompt_text' | 'prompt_input_not_found' };

export function findPromptTextarea(root: ParentNode = document): HTMLTextAreaElement | null {
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    ?? root.querySelector<HTMLTextAreaElement>('textarea');
  return textarea?.tagName === 'TEXTAREA' ? textarea : null;
}

export function insertTextIntoPromptTextarea(
  text: string,
  textarea: HTMLTextAreaElement | null = findPromptTextarea(),
): PromptTextInsertionResult {
  if (text.length === 0) return { ok: false, error: 'empty_prompt_text' };
  if (!textarea) return { ok: false, error: 'prompt_input_not_found' };

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const nextValue = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;

  setTextareaValue(textarea, nextValue);
  const caret = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  textarea.dispatchEvent(createPromptInputEvent(text));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();

  return { ok: true, insertedLength: text.length };
}

/**
 * 用给到的文本**整段替换**输入框（清掉旧内容）。
 *
 * 真机事故（2026-10-30）：自动续跑用的是 `insertTextIntoPromptTextarea`（按光标插入，
 * 不清空）。续跑若没发出去（服务端 5xx / 按钮点不到），提示词就留在框里，
 * 下一轮再追加一份 ⇒ 同一句堆 5 次，模型看到的是一条超长用户消息，只能从头再来。
 */
export function replaceTextInPromptTextarea(
  text: string,
  textarea: HTMLTextAreaElement | null = findPromptTextarea(),
): PromptTextInsertionResult {
  if (text.length === 0) return { ok: false, error: "empty_prompt_text" };
  if (!textarea) return { ok: false, error: "prompt_input_not_found" };

  setTextareaValue(textarea, text);
  textarea.selectionStart = textarea.selectionEnd = text.length;
  textarea.dispatchEvent(createPromptInputEvent(text));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.focus();

  return { ok: true, insertedLength: text.length };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  // Invalidate React's value tracker so it detects the change (mirror skill-popup.selectSkill)
  const tracker = (textarea as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  if (tracker) tracker.setValue('');

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(textarea, value);
    return;
  }
  textarea.value = value;
}

function createPromptInputEvent(text: string): Event {
  if (typeof InputEvent === 'function') {
    return new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    });
  }
  return new Event('input', { bubbles: true });
}
