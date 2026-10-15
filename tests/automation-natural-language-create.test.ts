/**
 * 自然语言建自动化（P2）测试
 */

import { describe, expect, it } from 'vitest';
import {
  buildAutomationDraftPrompt,
  createAutomationFromNaturalLanguage,
  decodeAutomationDraftPayload,
  deriveScheduleFromTimeExpression,
  extractJsonEnvelope,
  isStructurallyValidCron,
  normalizeAutomationDraft,
  parseAutomationInstructionLocal,
  parseTimeOfDay,
} from '../core/automation/natural-language-create';

describe('parseTimeOfDay', () => {
  it('解析早上9点', () => {
    expect(parseTimeOfDay('早上9点')).toEqual({ hour: 9, minute: 0 });
  });

  it('解析晚上8点半', () => {
    expect(parseTimeOfDay('晚上8点半')).toEqual({ hour: 20, minute: 30 });
  });

  it('解析下午3:30', () => {
    expect(parseTimeOfDay('下午3:30')).toEqual({ hour: 15, minute: 30 });
  });

  it('解析无效输入', () => {
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('无效')).toBeNull();
  });
});

describe('isStructurallyValidCron', () => {
  it('验证合法 cron', () => {
    expect(isStructurallyValidCron('0 9 * * *')).toBe(true);
    expect(isStructurallyValidCron('30 8 * * 1')).toBe(true);
  });

  it('验证非法 cron', () => {
    expect(isStructurallyValidCron('')).toBe(false);
    expect(isStructurallyValidCron('0 9 * *')).toBe(false);
    expect(isStructurallyValidCron('abc')).toBe(false);
  });
});

describe('deriveScheduleFromTimeExpression', () => {
  it('解析每天早上9点', () => {
    const result = deriveScheduleFromTimeExpression('每天早上9点');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('cron');
    expect(result?.expression).toBe('0 9 * * *');
  });

  it('解析每周一早上8点', () => {
    const result = deriveScheduleFromTimeExpression('每周一早上8点');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('cron');
    expect(result?.expression).toBe('0 8 * * 1');
  });

  it('解析手动触发', () => {
    const result = deriveScheduleFromTimeExpression('手动触发');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('manual');
    expect(result?.expression).toBeNull();
  });
});

describe('extractJsonEnvelope', () => {
  it('提取 JSON', () => {
    const result = extractJsonEnvelope('{"name":"test"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test' });
    }
  });

  it('提取带 markdown 的 JSON', () => {
    const result = extractJsonEnvelope('```json\n{"name":"test"}\n```');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test' });
    }
  });

  it('提取空字符串', () => {
    const result = extractJsonEnvelope('');
    expect(result.ok).toBe(false);
  });
});

describe('decodeAutomationDraftPayload', () => {
  it('解码合法 payload', () => {
    const result = decodeAutomationDraftPayload({
      name: '测试任务',
      prompt: '这是提示词',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true, minimumIntervalMinutes: 1 },
      promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.name).toBe('测试任务');
      expect(result.proposal.prompt).toBe('这是提示词');
    }
  });

  it('解码非对象', () => {
    const result = decodeAutomationDraftPayload('not an object');
    expect(result.ok).toBe(false);
  });
});

describe('parseAutomationInstructionLocal', () => {
  it('解析每天早上9点给我发深圳天气', () => {
    const result = parseAutomationInstructionLocal('每天早上9点给我发深圳天气');
    expect(result.proposal.schedule?.kind).toBe('cron');
    expect(result.proposal.schedule?.expression).toBe('0 9 * * *');
    expect(result.proposal.prompt).toContain('深圳天气');
  });

  it('解析空指令', () => {
    const result = parseAutomationInstructionLocal('');
    expect(result.issues.some((i) => i.code === 'instruction_empty')).toBe(true);
  });
});

describe('normalizeAutomationDraft', () => {
  it('归一化合法 draft', () => {
    const draft = normalizeAutomationDraft({
      name: '测试任务',
      prompt: '这是提示词',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true, minimumIntervalMinutes: 1 },
      promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
    });
    expect(draft.ready).toBe(true);
    expect(draft.createInput.name).toBe('测试任务');
  });

  it('归一化缺少 name 和 prompt', () => {
    const draft = normalizeAutomationDraft({});
    expect(draft.createInput.name).toBe('自然语言自动化');
    expect(draft.createInput.prompt).toBe('请执行任务。');
  });
});

describe('createAutomationFromNaturalLanguage', () => {
  it('本地规则兜底：每天早上9点给我发深圳天气', async () => {
    const draft = await createAutomationFromNaturalLanguage({
      instruction: '每天早上9点给我发深圳天气',
    });
    expect(draft.ready).toBe(true);
    expect(draft.createInput.schedule.kind).toBe('cron');
    expect(draft.createInput.schedule.expression).toBe('0 9 * * *');
    expect(draft.createInput.prompt).toContain('深圳天气');
  });

  it('空指令', async () => {
    const draft = await createAutomationFromNaturalLanguage({
      instruction: '',
    });
    expect(draft.ready).toBe(false);
    expect(draft.issues.some((i) => i.code === 'instruction_empty')).toBe(true);
  });
});

describe('buildAutomationDraftPrompt', () => {
  it('构造 Prompt', () => {
    const prompt = buildAutomationDraftPrompt({
      instruction: '每天早上9点给我发深圳天气',
      now: Date.now(),
      timezone: 'Asia/Shanghai',
    });
    expect(prompt.system).toContain('自动化配置解析器');
    expect(prompt.user).toContain('每天早上9点给我发深圳天气');
  });
});
