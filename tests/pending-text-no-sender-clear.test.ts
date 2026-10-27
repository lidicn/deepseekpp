/**
 * #88 复核：发送端**不得**清 pending chat text store（PM 判上一版为回归并撤销）。
 *
 * 上一版把 #88 当"消息已消费、store 残留"来修，在 openSidePanelAndSendText 里加了
 * `await pendingChatTextStore.clear()`。查证后前提不成立：
 *   ① `OPEN_CHAT_WITH_TEXT` 全仓**没有监听端**（不在 core/types.ts 消息 union；
 *      侧栏 11 处 onMessage.addListener 逐个核对都不消费它）⇒ storage 是唯一交付通道；
 *   ② 消费端 `pending-text-controller.ts:31` 拿到文本后**自己** clear；
 *   ③ 发送端抢先 clear 会吃掉文本：`chrome.sidePanel.open()` 是异步的，侧栏未打开时
 *      （右键「发送到对话」主路径）面板加载完 read() 已被清空 ⇒ 选中文本静默丢失。
 *
 * A. 结构契约：写入先于发送，且函数体内没有任何 clear/remove（与项目既有
 *    `pending-chat-text.test.ts` 同一口径 —— 读源码文本断言）。
 * B. 行为契约：侧栏未打开（sendMessage 抛「Receiving end does not exist」）时
 *    文本必须仍在 store，等侧栏下次读；清理由消费端做，且只投递一次。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { startPendingTextConsumer } from '../entrypoints/sidepanel/controllers/pending-text-controller';
import { deliverRuntimeMessageBestEffort } from '../core/messaging/broadcast';
import type { PendingChatTextStore } from '../core/chat/pending-text';

function deliveryFunctionBody(): string {
  const background = readFileSync('entrypoints/background.ts', 'utf8');
  const start = background.indexOf('async function openSidePanelAndSendText');
  const end = background.indexOf('async function ensureBuiltInMcpPresets', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return background.slice(start, end);
}

describe('#88 发送端不得清 store（撤销上一版回归）', () => {
  it('★ 结构：写入先于发送，且函数体内不含 clear/remove', () => {
    const body = deliveryFunctionBody();
    expect(body).toContain('pendingChatTextStore.write(text)');
    expect(body).toContain("runtime.sendMessage({ type: 'OPEN_CHAT_WITH_TEXT', text })");
    expect(body.indexOf('pendingChatTextStore.write(text)')).toBeLessThan(
      body.indexOf("runtime.sendMessage({ type: 'OPEN_CHAT_WITH_TEXT', text })"),
    );
    // 本次回归的核心断言：发送端不许清
    expect(body).not.toContain('pendingChatTextStore.clear');
    expect(body).not.toContain('storage.local.remove');
  });

  it('★ 行为：侧栏未打开时文本留在 store，等下次读，且只投递一次', async () => {
    let value: string | null = null;
    const listeners: Array<(text: string | null) => void> = [];
    const store: PendingChatTextStore = {
      async read() { return value; },
      async write(text) { value = text; listeners.forEach((l) => l(text)); },
      async clear() { value = null; listeners.forEach((l) => l(null)); },
      subscribe(listener: (text: string | null) => void) {
        listeners.push(listener);
        return () => {};
      },
    };

    const reported: string[] = [];
    await store.write('用户选中的文本');
    // 真实 best-effort 投递：内部 .catch，发送失败不往上抛
    deliverRuntimeMessageBestEffort(
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
      'pending_chat_text_notification_failed',
      (code: string) => { reported.push(code); },
    );
    await new Promise((r) => setTimeout(r, 10));

    // 发送失败不能清掉文本 —— 它是给"下次打开的侧栏"的信箱
    expect(value).toBe('用户选中的文本');
    // 「没有接收端」属预期情形，不该当异常上报
    expect(reported).toEqual([]);

    // 侧栏后来打开 ⇒ 消费端读到并**自己**清理
    const seen: string[] = [];
    const consumer = startPendingTextConsumer({
      store,
      onText: (text) => { seen.push(text); },
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['用户选中的文本']);
    expect(value).toBeNull(); // 由消费端清的，不是发送端

    // 再打开一次不得重复投递旧文本（原审计担心的"残留污染"由此路径保证）
    const again: string[] = [];
    const second = startPendingTextConsumer({
      store,
      onText: (text) => { again.push(text); },
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(again).toEqual([]);

    consumer.stop();
    second.stop();
  });
});
