import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  buildCandidate,
  extractSignals,
  DEFAULT_GATE_CONFIG,
} from '../core/memory/extractor';

describe('extractor gate 新能力', () => {
  it('token 超限返 too_long', () => {
    const longText = '项目是'.repeat(300); // 约 600 字符，远超 maxTokens=200
    const signals = extractSignals(longText);
    const gate = evaluateGate(3, null, signals, longText, DEFAULT_GATE_CONFIG);
    expect(gate.trigger).toBe(false);
    expect(gate.reason).toBe('too_long');
  });

  it('凭据命中返 policy（fail-closed）', () => {
    const text = '我的 API key 是 sk-abc123def456ghi789jkl';
    const signals = extractSignals(text);
    const gate = evaluateGate(3, null, signals, text, DEFAULT_GATE_CONFIG);
    expect(gate.trigger).toBe(false);
    expect(gate.reason).toBe('policy');
  });

  it('正常文本能通过 gate 生成候选', () => {
    const text = '我喜欢用 TypeScript';
    const signals = extractSignals(text);
    const gate = evaluateGate(3, null, signals, text, DEFAULT_GATE_CONFIG);
    expect(gate.trigger).toBe(true);
    const candidate = buildCandidate(text, signals);
    expect(candidate).not.toBeNull();
  });
});

describe('dedupeKey', () => {
  it('dedupeKey 是 hash 格式而非前 50 字符', () => {
    const text = '用户偏好';
    const signals = extractSignals(text);
    const candidate = buildCandidate(text, signals);
    expect(candidate).not.toBeNull();
    // dedupeKey 格式应为 "kind:8位hex"
    expect(candidate!.dedupeKey).toMatch(/^[a-z]+:[0-9a-f]{8}$/);
    // 不应该等于原文前 50 字符
    expect(candidate!.dedupeKey).not.toBe(text.slice(0, 50));
  });
});
