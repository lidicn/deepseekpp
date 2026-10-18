import { describe, expect, it } from 'vitest';
import { webHasContinuableChain } from '../core/inline-agent/pi/chain-continuation';

// P1-2：web 后端第一步工具调用在 parentMessageId 尚未建立时也放行；
// 第二轮起严格要求有效页面链父 id（回归 R2：第二轮 id 丢失仍阻断）。
describe('webHasContinuableChain（P1-2 首轮工具链放行）', () => {
  it('首轮 stepIndex=0：parentMessageId=null 也放行（修复痛点 1-B）', () => {
    expect(webHasContinuableChain({ stepIndex: 0, parentMessageId: null })).toBe(true);
    expect(webHasContinuableChain({ stepIndex: 0, parentMessageId: 101 })).toBe(true);
  });

  it('第二轮起：parentMessageId=null 被阻断（不削弱链分叉防护）', () => {
    expect(webHasContinuableChain({ stepIndex: 1, parentMessageId: null })).toBe(false);
    expect(webHasContinuableChain({ stepIndex: 2, parentMessageId: null })).toBe(false);
  });

  it('第二轮起：存在有效 parentMessageId 放行', () => {
    expect(webHasContinuableChain({ stepIndex: 1, parentMessageId: 101 })).toBe(true);
    expect(webHasContinuableChain({ stepIndex: 5, parentMessageId: 202 })).toBe(true);
  });
});
