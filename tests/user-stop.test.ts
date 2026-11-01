/**
 * t3-C：用户主动停止（点「停止」）的终态识别 + content 接线守卫。
 *
 * 现场（t1 2026-11-01 实测）：composer 的发送按钮生成中变成停止方块
 * （`.ds-button--primary.ds-button--filled`，全页唯一，svg path 前缀 `M2 4.88`）；
 * 点它后服务端 EOF 无 FINISHED ⇒ truncated=true ⇒ 旧判据自动再发一条 completion。
 *
 * 变异自证：
 *   - `isStopControlTarget` 去掉图标判断 ⇒ 用例 2 红（发送态也误判成停止）；
 *   - `consume` 不清空标记 ⇒ 用例 3 红（一次停止挡住后续所有空回答续跑）；
 *   - content.ts 的自动续跑判据去掉 `!userStopped` ⇒ 接线守卫红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  USER_STOP_BUTTON_SELECTOR,
  USER_STOP_TTL_MS,
  createUserStopTracker,
  installUserStopClickListener,
  isStopControlTarget,
} from '../core/chat/user-stop';

const CONTENT_SOURCE = readFileSync(
  join(__dirname, '..', 'entrypoints', 'content.ts'),
  'utf-8',
);

function makeComposerButton(iconPath: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'ds-button ds-button--primary ds-button--filled ds-button--circle';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', iconPath);
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

describe('user-stop：识别与一次性标记', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('★ 停止态点击命中；发送态/普通元素不命中', () => {
    const stopButton = makeComposerButton('M2 4.88C2 3.68 2.9 3 4 3H20C21.1 3 22 3.68 22 4.88V19.12C22 20.32 21.1 21 20 21H4C2.9 21 2 20.32 2 19.12V4.88Z');
    document.body.appendChild(stopButton);
    const stopIcon = stopButton.querySelector('path')!;
    expect(isStopControlTarget(stopIcon)).toBe(true);
    expect(isStopControlTarget(stopButton)).toBe(true);

    const sendButton = makeComposerButton('M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042 9.2 1.42L21.7 13.42');
    document.body.appendChild(sendButton);
    expect(isStopControlTarget(sendButton.querySelector('path'))).toBe(false);

    const plain = document.createElement('div');
    document.body.appendChild(plain);
    expect(isStopControlTarget(plain)).toBe(false);
    expect(isStopControlTarget(null)).toBe(false);
  });

  it('★★ 监听器只对停止态点击回调，卸载后不再触发', () => {
    const onStop = vi.fn();
    const detach = installUserStopClickListener(document, onStop);

    const stopButton = makeComposerButton('M2 4.88C2 3.68 2.9 3 4 3H20V21H4Z');
    document.body.appendChild(stopButton);
    stopButton.querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onStop).toHaveBeenCalledTimes(1);

    const sendButton = makeComposerButton('M8.3125 0.980206C8.66767 1.05312');
    document.body.appendChild(sendButton);
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onStop).toHaveBeenCalledTimes(1);

    detach();
    stopButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('★★ 停止标记是一次性的 + 有 TTL（不挡住下一次真空回答续跑）', () => {
    const tracker = createUserStopTracker(1_000);
    expect(tracker.consume(10_000)).toBe(false);

    tracker.noteStop(10_000);
    expect(tracker.peek(10_100)).toBe(true);
    expect(tracker.consume(10_200)).toBe(true); // 消费一次
    expect(tracker.consume(10_300)).toBe(false); // 同一次停止不能挡两次

    tracker.noteStop(20_000);
    expect(tracker.consume(20_000 + USER_STOP_TTL_MS + 1)).toBe(false); // 过期
    tracker.noteStop(30_000);
    tracker.clear();
    expect(tracker.peek(30_001)).toBe(false);
  });
});

describe('content.ts 接线守卫（停止后不得自动续跑）', () => {
  it('★ 停止按钮选择器与 t1 实测一致（全页唯一那颗 composer 按钮）', () => {
    expect(USER_STOP_BUTTON_SELECTOR).toBe('.ds-button--primary.ds-button--filled');
    expect(CONTENT_SOURCE).toContain('installUserStopClickListener(document');
  });

  it('★★ 自动续跑 / agent 续轮都以 !userStopped 为前置条件', () => {
    const emptyGateIndex = CONTENT_SOURCE.indexOf('(emptyAnswerVerdict === "empty" || complete.truncated === true)');
    expect(emptyGateIndex).toBeGreaterThan(0);
    const emptyGateLine = CONTENT_SOURCE.slice(
      CONTENT_SOURCE.lastIndexOf('\n', emptyGateIndex) + 1,
      emptyGateIndex,
    );
    expect(emptyGateLine).toContain('!userStopped');

    const planGateIndex = CONTENT_SOURCE.indexOf('decideChatLayerContinuation({');
    expect(planGateIndex).toBeGreaterThan(0);
    const planGateLine = CONTENT_SOURCE.slice(
      CONTENT_SOURCE.lastIndexOf('\n', planGateIndex) + 1,
      planGateIndex,
    );
    expect(planGateLine).toContain('!userStopped');

    expect(CONTENT_SOURCE).toContain("'skipped:user_stopped'");
    expect(CONTENT_SOURCE).toContain("message: \"auto_continue_skipped_user_stop\"");
  });
});
