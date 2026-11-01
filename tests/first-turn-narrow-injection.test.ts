/**
 * t3-A：首轮窄化注入（只剥「记忆段 + 工具目录段（含工具广告尾段）」，其余能力保留）。
 *
 * 契约（DCD 裁定乙之后的新语义）：
 *   - 首轮：系统提示 / 技能激活 / preset / model_type 全部保留；
 *     只剥 `## 已有记忆`（en `## Existing Memories`）与 `### Available Tools`，
 *     以及同属工具广告的「联网搜索指引 / 工具格式提醒」；首轮 prompt ≤2KB。
 *   - 回滚：`localStorage["dpp:firstTurnMemory"]="1"` ⇒ 首轮不剥（恢复全量注入）。
 *   - `dpp:skipAugmentation=1` 仍原样透传（调试开关优先）。
 *
 * 体积口径说明（实测）：DeepSeek 网页现场是 `thinking_enabled=true`（t1 现场 `base 576`
 * 正是 zh systemThinking 模板的 base），该口径首轮 = 692B；非 thinking 模板的 base 本身就有
 * 1.7KB + 记忆保存规则段，剥完约 3.1KB —— 仍远小于全量 13.6KB，但达不到 ≤2KB。
 * 因此 ≤2KB 的硬判据按**现场口径（thinking on）**断言；非 thinking 只断言"工具广告/记忆已剥 + 显著缩小"。
 *
 * 变异自证：
 *   - 去掉 strip 调用 → 「首轮不含记忆/目录」用例红；
 *   - 去掉 `!resolveFirstTurnMemoryRestoreFlag()` 判断 → 回滚用例红；
 *   - 去掉 safeSectionEnd 的可见用户输入边界 → 最后一段用例红（用户原文被吞）；
 *   - 首轮仍把描述符渲染进 prompt → ≤2KB 用例红（默认描述符下实测 4.9KB）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_DESCRIPTORS } from '../core/tool';
import { augmentRequestBody } from '../core/interceptor/request-augmentation';
import { extractVisibleUserPrompt } from '../core/prompt';
import {
  FIRST_TURN_CATALOG_MARKER,
  FIRST_TURN_MEMORY_MARKER,
  stripFirstTurnOptionalSections,
} from '../core/prompt/first-turn-strip';

const CANNED_PROMPT = [
  '## Role',
  'You are a helpful assistant.',
  '',
  '## Tools',
  'Call tools by emitting XML tags.',
  '',
  '### Available Tools',
  '',
  '### Tool memory_save',
  'Title: Save memory',
  '',
  '## Existing Memories',
  '',
  '- MEMORY_SECRET_LINE',
  '',
  '## Memory Rules',
  'Save durable facts.',
].join('\n');

const WITH_USER_PROMPT = [
  '## Role',
  'You are a helpful assistant.',
  '',
  '### Available Tools',
  '',
  '### Tool memory_save',
  'Title: Save memory',
  '',
  '## Existing Memories',
  '',
  '- MEMORY_SECRET_LINE',
  '<!-- deepseek-pp-visible-user-prompt:start -->',
  'hello user',
  '<!-- deepseek-pp-visible-user-prompt:end -->',
  '',
  '---',
  'Tool call format reminder:',
  'Available tool tag names: memory_save',
].join('\n');

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

describe('stripFirstTurnOptionalSections（与 prompt-segments 同构）', () => {
  it('★ 剥掉记忆段与工具目录段，其余段原样保留', () => {
    const result = stripFirstTurnOptionalSections(CANNED_PROMPT);
    expect(result.strippedCatalog).toBe(true);
    expect(result.strippedMemory).toBe(true);
    expect(result.strippedToolReminder).toBe(false);
    expect(result.prompt).not.toContain(FIRST_TURN_CATALOG_MARKER);
    expect(result.prompt).not.toContain('### Tool memory_save');
    expect(FIRST_TURN_MEMORY_MARKER.test(result.prompt)).toBe(false);
    expect(result.prompt).not.toContain('MEMORY_SECRET_LINE');
    // 保留：系统提示 + 记忆保存规则（这是规则，不是记忆正文）
    expect(result.prompt).toContain('## Role');
    expect(result.prompt).toContain('## Memory Rules');
    expect(result.prompt).toContain('Save durable facts.');
  });

  it('★★ 记忆段是最后一段时，不得吞掉可见用户输入；工具广告尾段一起剥掉', () => {
    const result = stripFirstTurnOptionalSections(WITH_USER_PROMPT);
    expect(result.strippedToolReminder).toBe(true);
    expect(result.prompt).toContain('<!-- deepseek-pp-visible-user-prompt:start -->');
    expect(result.prompt).toContain('hello user');
    expect(result.prompt).not.toContain('Tool call format reminder:');
    expect(result.prompt).not.toContain('Available tool tag names:');
    expect(result.prompt).not.toContain('MEMORY_SECRET_LINE');
    // 悬空分隔线不得留下
    expect(result.prompt.trimEnd().endsWith('---')).toBe(false);
  });

  it('无标记时原样返回，且重复调用幂等', () => {
    const plain = 'just a user prompt with no markers';
    const first = stripFirstTurnOptionalSections(plain);
    expect(first).toEqual({
      prompt: plain,
      strippedCatalog: false,
      strippedMemory: false,
      strippedToolReminder: false,
    });
    const twice = stripFirstTurnOptionalSections(first.prompt);
    expect(twice.prompt).toBe(plain);
    expect(twice.strippedCatalog).toBe(false);
    expect(twice.strippedMemory).toBe(false);
    expect(twice.strippedToolReminder).toBe(false);
  });
});

describe('首轮窄化注入（augmentRequestBody）', () => {
  afterEach(() => {
    localStorage.removeItem('dpp:firstTurnMemory');
    localStorage.removeItem('dpp:skipAugmentation');
  });

  it('★★ 现场口径（zh + thinking）：保留系统提示/技能/preset/model_type，剥掉记忆与工具目录，prompt ≤2KB', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: '/writer hello',
      parent_message_id: null,
      thinking_enabled: true,
    }), augmentationState());

    const body = JSON.parse(result?.body ?? '{}') as { prompt?: string; model_type?: string };
    const prompt = body.prompt ?? '';
    // 保留能力
    expect(prompt).toContain('## Tools');
    expect(prompt).toContain('Preset body for the first turn.');
    expect(prompt).toContain('Private writer instructions.');
    expect(extractVisibleUserPrompt(prompt)).toBe('/writer hello');
    expect(body.model_type).toBe('expert');
    expect(result?.agentTaskPrompt).toContain('Private writer instructions.');
    // 剥掉两段（含工具广告：联网搜索指引 / 工具格式提醒）
    expect(prompt).not.toContain(FIRST_TURN_CATALOG_MARKER);
    expect(prompt).not.toContain('## 已有记忆');
    expect(prompt).not.toContain('MEMORY_SECRET_LINE');
    expect(prompt).not.toContain('## 网络搜索规则');
    expect(result?.usedMemoryIds).toEqual([]);
    expect(result?.firstTurnNarrowed).toBe(true);
    // 体积判据（现场口径首轮 ≤2KB）
    expect(bytesOf(prompt)).toBeLessThanOrEqual(2048);
    expect(result?.messageCount).toBe(1);
  });

  it('非 thinking 口径：工具广告/记忆已剥，体积仍显著小于全量（但 base 本身较大）', () => {
    const state = { ...augmentationState(), locale: 'en' as const };
    const narrowed = augmentRequestBody(JSON.stringify({
      prompt: 'hello',
      parent_message_id: null,
      thinking_enabled: false,
    }), state);
    const narrowedPrompt = JSON.parse(narrowed?.body ?? '{}').prompt as string;
    expect(narrowedPrompt).not.toContain(FIRST_TURN_CATALOG_MARKER);
    expect(narrowedPrompt).not.toContain('## Existing Memories');
    expect(narrowedPrompt).not.toContain('MEMORY_SECRET_LINE');
    expect(narrowedPrompt).not.toContain('Available tool tag names:');
    expect(bytesOf(narrowedPrompt)).toBeLessThanOrEqual(4096);

    localStorage.setItem('dpp:firstTurnMemory', '1');
    try {
      const full = augmentRequestBody(JSON.stringify({
        prompt: 'hello',
        parent_message_id: null,
        thinking_enabled: false,
      }), state);
      const fullPrompt = JSON.parse(full?.body ?? '{}').prompt as string;
      expect(bytesOf(fullPrompt)).toBeGreaterThan(bytesOf(narrowedPrompt) + 2048);
    } finally {
      localStorage.removeItem('dpp:firstTurnMemory');
    }
  });

  it('★ 回滚开关 dpp:firstTurnMemory=1 ⇒ 首轮恢复记忆与工具目录（全量注入）', () => {
    localStorage.setItem('dpp:firstTurnMemory', '1');
    const result = augmentRequestBody(JSON.stringify({
      prompt: 'hello',
      parent_message_id: null,
      thinking_enabled: true,
    }), augmentationState());

    const body = JSON.parse(result?.body ?? '{}') as { prompt?: string };
    const prompt = body.prompt ?? '';
    expect(prompt).toContain(FIRST_TURN_CATALOG_MARKER);
    expect(prompt).toContain('## 已有记忆');
    expect(prompt).toContain('MEMORY_SECRET_LINE');
    expect(prompt).toContain('## 网络搜索规则');
    expect(result?.firstTurnNarrowed).toBeUndefined();
    expect(result?.usedMemoryIds).toEqual([1]);
    // 回滚后回到全量体积（>2KB），证明这条开关不是空转
    expect(bytesOf(prompt)).toBeGreaterThan(2048);
  });

  it('第二轮仍全量注入（记忆 + 目录 + 搜索指引都在）', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: 'hello again',
      parent_message_id: 12,
      thinking_enabled: true,
    }), augmentationState());

    const body = JSON.parse(result?.body ?? '{}') as { prompt?: string };
    const prompt = body.prompt ?? '';
    expect(prompt).toContain(FIRST_TURN_CATALOG_MARKER);
    expect(prompt).toContain('## 已有记忆');
    expect(prompt).toContain('MEMORY_SECRET_LINE');
    expect(prompt).toContain('## 网络搜索规则');
    expect(result?.firstTurnNarrowed).toBeUndefined();
  });

  it('dpp:skipAugmentation=1 仍原样透传（调试开关优先）', () => {
    localStorage.setItem('dpp:skipAugmentation', '1');
    const result = augmentRequestBody(JSON.stringify({
      prompt: 'hello',
      parent_message_id: null,
      thinking_enabled: true,
    }), augmentationState());
    expect(JSON.parse(result?.body ?? '{}')).toEqual({
      prompt: 'hello',
      parent_message_id: null,
      thinking_enabled: true,
    });
  });
});

function augmentationState() {
  return {
    memories: [memory(1, 'global', undefined, 'Global memory', 'MEMORY_SECRET_LINE')],
    skills: [{
      name: 'writer',
      instructions: 'Private writer instructions.',
      memoryEnabled: true,
    }],
    activePreset: {
      id: 'preset-first-turn',
      name: 'First Turn',
      content: 'Preset body for the first turn.',
      createdAt: 1,
      updatedAt: 1,
    },
    modelType: 'expert' as const,
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
    messageCount: 0,
    locale: 'zh-CN' as const,
  };
}

function memory(
  id: number,
  scope: 'global' | 'project',
  projectId: string | undefined,
  name: string,
  content: string,
) {
  return {
    id,
    syncId: `sync-${id}`,
    scope,
    projectId,
    type: 'reference' as const,
    name,
    content,
    description: '',
    tags: [],
    pinned: true,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessedAt: 1,
  };
}
