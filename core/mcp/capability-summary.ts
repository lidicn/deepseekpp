/**
 * L1 summary for capability-projected (hidden) MCP tools.
 *
 * Lives inside the catalog block (rendered via renderToolSchemas' third
 * argument) so it is always visible next to the tools it refers to (R2-d).
 */
import type { ToolDescriptor } from '../tool/types';

export const HIDDEN_SUMMARY_BYTES_PER_TOOL = 40;

export interface McpHiddenSummaryOptions {
  /** Invocation name of the `describe` catalog helper (verbatim, R4-c). */
  readonly describeToolName: string;
  /** Invocation name of the `invoke` catalog helper (verbatim, R4-c). */
  readonly invokeToolName: string;
  readonly locale?: string;
}

export function hiddenSummaryByteBudget(toolCount: number): number {
  return HIDDEN_SUMMARY_BYTES_PER_TOOL * toolCount;
}

export function renderMcpHiddenToolSummary(
  hidden: readonly ToolDescriptor[],
  options: McpHiddenSummaryOptions,
): string {
  if (hidden.length === 0) return '';

  const groups = new Map<string, string[]>();
  for (const descriptor of hidden) {
    const serverId = descriptor.provider.id;
    const names = groups.get(serverId) ?? [];
    names.push(descriptor.name);
    groups.set(serverId, names);
  }

  const guidance = options.locale === 'zh'
    ? `隐藏工具：完整 Parameters JSON Schema 用 ${options.describeToolName}，直接执行用 ${options.invokeToolName}。`
    : `Hidden tools: use ${options.describeToolName} for the full Parameters JSON Schema, use ${options.invokeToolName} to execute.`;

  const groupLines = [...groups.entries()].map(
    ([serverId, names]) => `${serverId}: ${names.join(', ')}`,
  );

  return [guidance, ...groupLines].join('\n');
}
