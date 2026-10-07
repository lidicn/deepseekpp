import { describe, it, expect } from 'vitest';
import { stripToolCalls, extractToolCalls } from '../core/interceptor/tool-parser';

// Build close-tag strings without literal "</" which oxc may parse as JSX
const LT = String.fromCharCode(60); // <
const SLASH = String.fromCharCode(47); // /
const CLOSE_INVOKE = LT + SLASH + 'invoke' + String.fromCharCode(62);
const CLOSE_PARAMETER = LT + SLASH + 'parameter' + String.fromCharCode(62);
const DOUBLE_BAR_CLOSE = LT + SLASH + '｜｜DSML｜｜ calls' + String.fromCharCode(62);

describe('S2-leak: double-bar DSML and orphan close tags', () => {
  it('strips orphan invoke close tag', () => {
    const input = 'Some thinking text ' + CLOSE_INVOKE + ' more text';
    const result = stripToolCalls(input);
    expect(result).not.toContain(CLOSE_INVOKE);
    expect(result).toContain('Some thinking text');
    expect(result).toContain('more text');
  });

  it('strips orphan parameter close tag', () => {
    const input = 'Thinking ' + CLOSE_PARAMETER + ' continues';
    const result = stripToolCalls(input);
    expect(result).not.toContain(CLOSE_PARAMETER);
    expect(result).toContain('Thinking');
    expect(result).toContain('continues');
  });

  it('strips orphan double-bar DSML close tag', () => {
    const input = 'Text ' + DOUBLE_BAR_CLOSE + ' end';
    const result = stripToolCalls(input);
    expect(result).not.toContain('｜｜DSML｜｜');
    expect(result).toContain('Text');
    expect(result).toContain('end');
  });

  it('strips the exact pattern from user report', () => {
    const input = 'Two important findings this round:\nHEAD advanced to 8eaec0b\n' + DOUBLE_BAR_CLOSE + ' ' + CLOSE_INVOKE + ' ' + CLOSE_PARAMETER;
    const result = stripToolCalls(input);
    expect(result).not.toContain('｜｜DSML｜｜');
    expect(result).not.toContain(CLOSE_INVOKE);
    expect(result).not.toContain(CLOSE_PARAMETER);
    expect(result).toContain('Two important findings');
  });

  it('still strips standard single-bar DSML', () => {
    const open = LT + '｜DSML｜tool_calls' + String.fromCharCode(62);
    const close = LT + SLASH + '｜DSML｜tool_calls' + String.fromCharCode(62);
    const invokeOpen = LT + '｜DSML｜invoke name="shell_exec"' + String.fromCharCode(62);
    const invokeClose = LT + SLASH + '｜DSML｜invoke' + String.fromCharCode(62);
    const paramOpen = LT + '｜DSML｜parameter name="command" string="true"' + String.fromCharCode(62);
    const paramClose = LT + SLASH + '｜DSML｜parameter' + String.fromCharCode(62);
    const input = 'text ' + open + invokeOpen + paramOpen + 'ls' + paramClose + invokeClose + close + ' end';
    const result = stripToolCalls(input);
    expect(result).not.toContain('｜DSML｜');
    expect(result).toContain('text');
    expect(result).toContain('end');
  });

  it('still strips standard XML tool calls', () => {
    const open = LT + 'shell_exec' + String.fromCharCode(62);
    const close = LT + SLASH + 'shell_exec' + String.fromCharCode(62);
    const input = 'text ' + open + '{"command":"ls"}' + close + ' end';
    const descriptor = {
      id: 'test-shell-exec',
      provider: 'test',
      name: 'shell_exec',
      invocationName: 'shell_exec',
      title: 'Shell Exec',
      description: 'Execute shell command',
      inputSchema: { type: 'object' },
      execution: { mode: 'local', enabled: true, risk: 'high' },
    } as any;
    const result = stripToolCalls(input, { descriptors: [descriptor] });
    expect(result).not.toContain('shell_exec');
    expect(result).toContain('text');
    expect(result).toContain('end');
  });

  it('does not strip legitimate text containing angle brackets', () => {
    const input = 'Use bold text';
    const result = stripToolCalls(input);
    expect(result).toBe('Use bold text');
  });
});
