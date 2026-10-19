import { describe, it, expect } from 'vitest';
import { checkConfig } from '../core/config/doctor';

describe('config-doctor', () => {
  it('全部通过', () => {
    const checks = checkConfig({ deepseek_pp_chat_enabled: true, deepseek_pp_resume_flags: {} });
    expect(checks.every(c => c.ok)).toBe(true);
  });
  it('类型不匹配', () => {
    const checks = checkConfig({ deepseek_pp_chat_enabled: 'yes' });
    expect(checks[0].ok).toBe(false);
  });
  it('缺失字段', () => {
    const checks = checkConfig({});
    expect(checks.every(c => c.ok)).toBe(false);
  });
});
