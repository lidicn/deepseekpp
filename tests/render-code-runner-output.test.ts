/**
 * 审计 #51：代码执行的 stdout/stderr 必须能显示给用户。
 *
 * 根因：上游 createToolExecutionRecord 曾把 result.output（结构化对象）整体
 * JSON.stringify 成字符串，下游 formatAgentCodeRunOutput 判
 * `typeof output === 'object'` 永远落空 ⇒ stdout/stderr 被静默丢弃，用户只看到
 * OK 或 Run failed。本测试直接喂对象形状的 output，断言输出含 stdout:/stderr:。
 */
import { describe, expect, it } from 'vitest';
import { formatAgentCodeRunOutput } from '../core/inline-agent/render-code-runner';

describe('formatAgentCodeRunOutput · stdout/stderr 可见性', () => {
  it('output 是对象时，stdout/stderr 都进输出', () => {
    const text = formatAgentCodeRunOutput({
      ok: true,
      output: { stdout: 'hello world', stderr: 'a warning', exitCode: 0 },
    });
    expect(text).toContain('stdout:');
    expect(text).toContain('hello world');
    expect(text).toContain('stderr:');
    expect(text).toContain('a warning');
  });

  it('只有 stdout 时只显示 stdout，不回退成裸 OK', () => {
    const text = formatAgentCodeRunOutput({
      ok: true,
      output: { stdout: 'just stdout' },
    });
    expect(text).toContain('stdout:');
    expect(text).toContain('just stdout');
  });

  it('output 是字符串（旧 bug 形态）时不冒充有 stdout —— 这是被修复的行为', () => {
    // 回归：上游已不再 stringify；万一有人改回去，这里应当仍能编译通过，
    // 但 formatAgentCodeRunOutput 对字符串 output 不会伪造 stdout 段。
    const text = formatAgentCodeRunOutput({ ok: true, output: '{"stdout":"x"}' });
    expect(text).not.toContain('stdout:');
  });
});
