/**
 * Single source of truth for the tool-catalog block template.
 *
 * The renderer (core/prompt/augmentation.ts) and the capability budget
 * (core/mcp/capability-projection.ts) both read bytes from the parts produced
 * here, so a template change can never leave the budget behind (R1-a).
 */

export const CATALOG_BLOCK_LABELS = {
  toolHeader: '### Tool ',
  title: 'Title: ',
  description: 'Description: ',
  aliases: 'Accepted tag names: ',
  schema: 'Parameters JSON Schema: ',
} as const;

/**
 * Line categories used by the R2-a decomposition. `format` / `openTag` /
 * `example` / `closeTag` / `invalid` exist so the *pre-change* template can be
 * decomposed with the same vocabulary; the compact layout never emits them.
 */
export type CatalogPartCategory =
  | 'identifier'
  | 'title'
  | 'description'
  | 'aliases'
  | 'format'
  | 'openTag'
  | 'example'
  | 'closeTag'
  | 'invalid'
  | 'schema'
  | 'sharedRegion'
  | 'hiddenSummary'
  | 'separator';

export interface CatalogPart {
  readonly category: CatalogPartCategory;
  /** Carries its own trailing newline, except the last part of a block. */
  readonly text: string;
}

export interface ToolBlockInput {
  readonly preferredName: string;
  readonly acceptedNames: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Compact tool block (R2-b): only non-derivable lines survive. */
export function createToolBlockParts(input: ToolBlockInput): CatalogPart[] {
  const parts: CatalogPart[] = [
    {
      category: 'identifier',
      text: `${CATALOG_BLOCK_LABELS.toolHeader}${input.preferredName}\n`,
    },
    { category: 'title', text: `${CATALOG_BLOCK_LABELS.title}${input.title}\n` },
    {
      category: 'description',
      text: `${CATALOG_BLOCK_LABELS.description}${input.description}\n`,
    },
  ];
  if (input.acceptedNames.length > 1) {
    parts.push({
      category: 'aliases',
      text: `${CATALOG_BLOCK_LABELS.aliases}${input.acceptedNames.join(', ')}\n`,
    });
  }
  parts.push({
    category: 'schema',
    text: `${CATALOG_BLOCK_LABELS.schema}${JSON.stringify(input.inputSchema)}`,
  });
  return parts;
}

export function renderCatalogParts(parts: readonly CatalogPart[]): string {
  return parts.map((part) => part.text).join('');
}

export function measureCatalogParts(parts: readonly CatalogPart[]): number {
  return parts.reduce((sum, part) => sum + utf8ByteLength(part.text), 0);
}

/**
 * Directory-level shared region (R2-b/R2-d). Everything that used to vary per
 * tool but only by tool name is stated once, here, inside the catalog block.
 * The three legal call forms it defines are what tests/mcp-catalog-equivalence
 * round-trips through the parser.
 */
const SHARED_REGION_LINES: Record<'en' | 'zh', readonly string[]> = {
  en: [
    '### Call format',
    'Emit <tag_name>{json}</tag_name>: tag_name is a tool\'s preferred or accepted tag name, {json} is a single JSON object matching its Parameters JSON Schema.',
    'Invalid formats: <invoke name="...">...</invoke>, <tool_call>...</tool_call>',
    'Example payloads are derivable from each schema and are omitted.',
  ],
  zh: [
    '### 调用格式',
    '调用写作 <标签名>{json}</标签名>：标签名用该工具的首选名或可接受标签名，{json} 是符合其 Parameters JSON Schema 的单个 JSON 对象。',
    '非法格式：<invoke name="...">...</invoke>、<tool_call>...</tool_call>',
    '示例体可由 schema 推导，已省略。',
  ],
};

export function renderCatalogSharedRegion(locale?: string): string {
  return (SHARED_REGION_LINES[locale === 'zh' ? 'zh' : 'en']).join('\n');
}

export interface ExamplePayloadSource {
  readonly inputSchema: {
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/**
 * Example payloads are a pure function of `inputSchema` (R2-b). Production
 * rendering no longer injects them; this stays as the schema-derived reference
 * implementation used by tests (R2-c equivalence evidence) and the describe
 * path. Moved verbatim from core/prompt/augmentation.ts:222-262.
 */
export function createExamplePayload(
  descriptor: ExamplePayloadSource,
): Record<string, unknown> {
  const properties = descriptor.inputSchema.properties ?? {};
  const required = descriptor.inputSchema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};

  for (const key of required) {
    payload[key] = exampleValue(properties[key]);
  }

  return payload;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
  if (value.enum && Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default: {
      const desc = typeof value.description === 'string' ? value.description.toLowerCase() : '';
      if (type === 'string' && (desc.includes('file path') || desc.includes('file_path') || desc.includes('filepath'))) {
        if (desc.includes('.pptx')) return './example.pptx';
        if (desc.includes('.docx')) return './example.docx';
        if (desc.includes('.xlsx')) return './example.xlsx';
        return './example.txt';
      }
      return 'value';
    }
  }
}
