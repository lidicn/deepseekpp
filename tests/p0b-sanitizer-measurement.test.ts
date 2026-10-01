/**
 * P0-b: sanitizer 增量测量
 * 量化 additionalProperties + 空 description 在工具 schema 中的字节占比。
 * 纯测量，不改任何行为。运行：npx vitest run tests/p0b-sanitizer-measurement.test.ts
 */
import { describe, it } from 'vitest';
import { measureToolSchemaBytes } from '../core/prompt/augmentation';
import { createMemoryToolDescriptors } from '../core/tool/memory';
import type { ToolDescriptor } from '../core/tool/types';

/** 递归删除 additionalProperties 字段 */
function stripAdditionalProperties(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripAdditionalProperties);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'additionalProperties') continue;
      result[k] = stripAdditionalProperties(v);
    }
    return result;
  }
  return obj;
}

/** 递归删除空/纯空白 description */
function stripEmptyDescriptions(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmptyDescriptions);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'description' && typeof v === 'string' && v.trim() === '') continue;
      result[k] = stripEmptyDescriptions(v);
    }
    return result;
  }
  return obj;
}

function cloneDescriptor(d: ToolDescriptor, schemaTransform: (s: unknown) => unknown): ToolDescriptor {
  return {
    ...d,
    inputSchema: schemaTransform(d.inputSchema) as ToolDescriptor['inputSchema'],
  };
}

/** 构造 Shell MCP 工具的描述符（基于实际 MCP schema） */
function createShellMcpDescriptors(): ToolDescriptor[] {
  const provider = {
    kind: 'mcp' as const,
    id: 'shell-local',
    displayName: 'Shell Local',
    transport: 'native_messaging' as const,
  };
  const base = { provider, execution: { mode: 'auto' as const, enabled: true, risk: 'low' as const } };
  return [
    {
      ...base,
      id: 'mcp:shell-local:shell_exec',
      name: 'shell_exec',
      invocationName: 'shell_exec',
      title: 'Execute Shell Command',
      description: 'Execute a shell command and return stdout, stderr, and exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory for the command.' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      ...base,
      id: 'mcp:shell-local:shell_status',
      name: 'shell_status',
      invocationName: 'shell_status',
      title: 'Shell Status',
      description: 'Get the status of a running shell command.',
      inputSchema: {
        type: 'object',
        properties: {
          command_id: { type: 'string', description: 'The command ID to check.' },
        },
        required: ['command_id'],
        additionalProperties: false,
      },
    },
    {
      ...base,
      id: 'mcp:shell-local:python_exec',
      name: 'python_exec',
      invocationName: 'python_exec',
      title: 'Execute Python',
      description: 'Execute Python code and return output.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python code to execute.' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds.' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
    {
      ...base,
      id: 'mcp:shell-local:local_file_read',
      name: 'local_file_read',
      invocationName: 'local_file_read',
      title: 'Read Local File',
      description: 'Read a file from the local filesystem.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'integer', description: 'Line offset to start reading.' },
          limit: { type: 'integer', description: 'Max number of lines to read.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      ...base,
      id: 'mcp:shell-local:local_file_stat',
      name: 'local_file_stat',
      invocationName: 'local_file_stat',
      title: 'File Stat',
      description: 'Get file metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ];
}

describe('P0-b: sanitizer 增量测量', () => {
  it('measures byte impact of additionalProperties + empty descriptions', () => {
    const allDescriptors: ToolDescriptor[] = [
      ...createMemoryToolDescriptors(),
      ...createShellMcpDescriptors(),
    ];

    console.log('\n========== P0-b Sanitizer Measurement ==========');
    console.log(`Total tools measured: ${allDescriptors.length}`);
    console.log('');

    let totalOriginal = 0;
    let totalNoAddlProps = 0;
    let totalNoEmptyDesc = 0;
    let totalBoth = 0;

    for (const d of allDescriptors) {
      const original = measureToolSchemaBytes(d);
      const noAddlProps = measureToolSchemaBytes(cloneDescriptor(d, stripAdditionalProperties));
      const noEmptyDesc = measureToolSchemaBytes(cloneDescriptor(d, stripEmptyDescriptions));
      const both = measureToolSchemaBytes(cloneDescriptor(d, (s) => stripEmptyDescriptions(stripAdditionalProperties(s))));

      totalOriginal += original;
      totalNoAddlProps += noAddlProps;
      totalNoEmptyDesc += noEmptyDesc;
      totalBoth += both;

      const savedBoth = original - both;
      const pctBoth = original > 0 ? ((savedBoth / original) * 100).toFixed(1) : '0.0';
      console.log(`  ${d.name.padEnd(22)} orig=${String(original).padStart(5)}B  noAP=${String(noAddlProps).padStart(5)}B  noED=${String(noEmptyDesc).padStart(5)}B  both=${String(both).padStart(5)}B  saved=${pctBoth}%`);
    }

    console.log('');
    console.log('---------- TOTAL ----------');
    console.log(`  Original:          ${totalOriginal} B`);
    console.log(`  Remove addlProps:  ${totalNoAddlProps} B  (saved ${totalOriginal - totalNoAddlProps} B, ${((totalOriginal - totalNoAddlProps) / totalOriginal * 100).toFixed(2)}%)`);
    console.log(`  Remove empty desc: ${totalNoEmptyDesc} B  (saved ${totalOriginal - totalNoEmptyDesc} B, ${((totalOriginal - totalNoEmptyDesc) / totalOriginal * 100).toFixed(2)}%)`);
    console.log(`  Remove both:       ${totalBoth} B  (saved ${totalOriginal - totalBoth} B, ${((totalOriginal - totalBoth) / totalOriginal * 100).toFixed(2)}%)`);
    console.log('');

    const totalSavedPct = ((totalOriginal - totalBoth) / totalOriginal) * 100;
    if (totalSavedPct < 5) {
      console.log(`  >>> CONCLUSION: savings = ${totalSavedPct.toFixed(2)}% < 5% threshold. P0-1 Schema 精简优化应关闭，不值得实施。`);
    } else {
      console.log(`  >>> CONCLUSION: savings = ${totalSavedPct.toFixed(2)}% >= 5% threshold. P0-1 Schema 精简值得实施。`);
    }
    console.log('==============================================\n');
  });
});
