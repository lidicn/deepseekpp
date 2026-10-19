import { describe, expect, it } from 'vitest';
import {
  buildShellAllowlistUpgrade,
  createShellMcpPresetInput,
  isShellMcpServer,
} from '../core/shell/policy';

// T29: 补既有 shell-policy.test.ts 未覆盖的策略边界：非 allow 模式、幂等无缺失、
// shell_session_exec 触发自动授写、preset 显式选项保留、服务名精确匹配。

describe('buildShellAllowlistUpgrade · non-allow and idempotent', () => {
  it('returns null for a non-allow mode (all / deny) without mutating', () => {
    expect(buildShellAllowlistUpgrade({ mode: 'deny', toolNames: ['shell_status'] })).toBeNull();
    expect(buildShellAllowlistUpgrade({ mode: 'all', toolNames: [] })).toBeNull();
  });

  it('returns null when every grantable tool is already present (idempotent, no duplicates)', () => {
    const already = {
      mode: 'allow' as const,
      toolNames: [
        'shell_status',
        'python_status',
        'local_skill_preview',
        'local_folder_pick',
        'local_file_stat',
        'local_file_read',
        'local_file_write',
      ],
    };
    expect(buildShellAllowlistUpgrade(already)).toBeNull();
  });

  it('auto-grants local_file_write when shell_session_exec is trusted (parallel to shell_exec)', () => {
    const upgraded = buildShellAllowlistUpgrade({
      mode: 'allow',
      toolNames: ['shell_session_exec'],
    });
    expect(upgraded).not.toBeNull();
    expect(upgraded!.toolNames).toContain('local_file_write');
    expect(upgraded!.toolNames).toContain('local_skill_preview');
    expect(upgraded!.toolNames.filter((n) => n === 'shell_session_exec')).toHaveLength(1);
  });

  it('preserves existing names and appends only missing grants', () => {
    const upgraded = buildShellAllowlistUpgrade({
      mode: 'allow',
      toolNames: ['local_file_read'],
    });
    expect(upgraded!.toolNames[0]).toBe('local_file_read');
    expect(upgraded!.toolNames.filter((n) => n === 'local_file_read')).toHaveLength(1);
    expect(upgraded!.toolNames).toContain('local_file_stat');
  });
});

describe('createShellMcpPresetInput · explicit options survive', () => {
  it('keeps explicit enabled / executionEnabled / custom nativeHost', () => {
    const preset = createShellMcpPresetInput({
      enabled: true,
      executionEnabled: true,
      nativeHost: 'custom.shell.host',
    });
    expect(preset.enabled).toBe(true);
    expect(preset.execution?.enabled).toBe(true);
    expect(preset.transport.nativeHost).toBe('custom.shell.host');
  });
});

describe('isShellMcpServer · exact match, case-sensitive', () => {
  it('rejects a differently-cased display name and an unknown host', () => {
    expect(isShellMcpServer({
      displayName: 'shell local',
      transport: { kind: 'native_messaging', nativeHost: 'com.example.other' },
    })).toBe(false);
    expect(isShellMcpServer({
      displayName: 'Shell Local Extra',
      transport: { kind: 'native_messaging', nativeHost: 'com.example.other' },
    })).toBe(false);
  });
});
