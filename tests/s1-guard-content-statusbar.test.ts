/**
 * S1 守护用例（审计 P1-56，entrypoints/content.ts updateAgentStatusBar）。
 *
 * content.ts 是有重副作用的巨型入口（测试不挂 DOM），与本仓既有 content 类测试一致，
 * 这里用**精确结构匹配**做守护：complete/error 两个分支拼 innerHTML 前必须对
 * options.message 调 escapeHtml。撤掉 escapeHtml ⇒ 下面两行精确串消失 ⇒ 本用例红。
 *
 * 注意：断言锁定完整一行结构，不用宽窗口正则，避免匹配到文件别处同名调用。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('S1 P1-56: 状态条 message 拼 innerHTML 前必须 escapeHtml', () => {
  const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');

  it('complete 分支对 options.message 做 escapeHtml', () => {
    // S2 抽文案后 shape: contentT("content.agent.statusBarComplete", { message: escapeHtml(...) })
    expect(source).toContain(
      'contentT("content.agent.statusBarComplete", { message: escapeHtml(String(options?.message ?? "")) })',
    );
  });

  it('error 分支对 options.message 做 escapeHtml', () => {
    expect(source).toContain(
      'contentT("content.agent.statusBarError", { message: escapeHtml(String(options?.message ?? "")) })',
    );
  });
});
