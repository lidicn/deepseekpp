/**
 * Structured sanitizer for third-party MCP `inputSchema` / `outputSchema`.
 *
 * Contract:
 *  - Pure: no I/O, no mutation of the input value, deterministic output.
 *  - Recursive over `properties`, `items`, `additionalProperties`, the
 *    `anyOf` / `oneOf` / `allOf` arrays and `$defs`.
 *  - Idempotent: output is always rebuilt in the canonical keyword order
 *    below, so a second pass is byte-identical to the first.
 *  - `$ref` closure: `$defs` entries reachable through `$ref` chains are kept
 *    transitively; unreachable entries are dropped. Opaque references keep
 *    every `$defs` entry (conservative, never dangling).
 *
 * Kept (semantic core): $ref $defs type description nullable enum const
 *   properties required items minimum maximum minLength
 *   maxLength pattern format anyOf oneOf allOf
 *   additionalProperties (object form only; boolean form dropped — see below)
 * Dropped: $schema $id $comment title examples example default deprecated
 *   readOnly writeOnly contentEncoding contentMediaType, every unknown key,
 *   and additionalProperties in boolean form (false/true).
 */

const SCHEMA_KEYWORDS = [
  '$ref',
  '$defs',
  'type',
  'description',
  'nullable',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'anyOf',
  'oneOf',
  'allOf',
] as const;

type SchemaKeyword = (typeof SCHEMA_KEYWORDS)[number];

/** Documented drop list (R3-a). Kept as data so tests can assert it. */
export const DROPPED_SCHEMA_KEYWORDS: readonly string[] = [
  '$schema',
  '$id',
  '$comment',
  'title',
  'examples',
  'example',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
];

export const KEPT_SCHEMA_KEYWORDS: readonly string[] = SCHEMA_KEYWORDS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeToolSchema(value: unknown): Record<string, unknown> {
  return trimUnreachableDefs(sanitizeSchemaNode(value));
}

function sanitizeSchemaNode(value: unknown): Record<string, unknown> {
  const source = isPlainObject(value) ? value : {};
  const result: Record<string, unknown> = {};
  for (const keyword of SCHEMA_KEYWORDS) {
    if (!Object.prototype.hasOwnProperty.call(source, keyword)) continue;
    const sanitized = sanitizeKeyword(keyword, source[keyword]);
    if (sanitized !== undefined) result[keyword] = sanitized;
  }
  return result;
}

function sanitizeKeyword(keyword: SchemaKeyword, value: unknown): unknown {
  switch (keyword) {
    case '$ref':
      return typeof value === 'string' ? value : undefined;
    case '$defs':
    case 'properties':
      return sanitizeSchemaMap(value);
    case 'type':
      return sanitizeType(value);
    case 'description':
    case 'pattern':
    case 'format':
      return typeof value === 'string' ? value : undefined;
    case 'nullable':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return Array.isArray(value) ? value.map(copyJsonValue) : undefined;
    case 'const':
      return copyJsonValue(value);
    case 'required':
      return sanitizeRequired(value);
    case 'additionalProperties':
      // Boolean form (false/true) has no generation-guidance value:
      // false is enforced by the execution layer's field whitelist;
      // true is already the JSON Schema default. Object form (e.g.
      // {type:'string'}) carries map-value-type semantics (shell env)
      // and MUST be preserved.
      if (typeof value === 'boolean') return undefined;
      return isPlainObject(value) ? sanitizeSchemaNode(value) : undefined;
    case 'items':
      if (Array.isArray(value)) return value.map(sanitizeSchemaNode);
      return isPlainObject(value) ? sanitizeSchemaNode(value) : undefined;
    case 'minimum':
    case 'maximum':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'minLength':
    case 'maxLength':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
    case 'anyOf':
    case 'oneOf':
    case 'allOf':
      return Array.isArray(value) ? value.map(sanitizeSchemaNode) : undefined;
    default:
      return undefined;
  }
}

function sanitizeType(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const types = value.filter((entry): entry is string => typeof entry === 'string');
  return types.length > 0 ? [...new Set(types)] : undefined;
}

function sanitizeRequired(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const required: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || seen.has(entry)) continue;
    seen.add(entry);
    required.push(entry);
  }
  return required;
}

function sanitizeSchemaMap(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sanitizeSchemaNode(entry);
  }
  return result;
}

function copyJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJsonValue);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = copyJsonValue(entry);
    }
    return result;
  }
  if (value === null) return null;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

interface RefScan {
  readonly names: Set<string>;
  opaque: boolean;
}

function scanRefs(node: unknown, scan: RefScan): void {
  if (Array.isArray(node)) {
    for (const entry of node) scanRefs(entry, scan);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, entry] of Object.entries(node)) {
    if (key === '$ref') {
      if (typeof entry !== 'string') {
        scan.opaque = true;
        continue;
      }
      const name = defNameFromRef(entry);
      if (name === null) scan.opaque = true;
      else scan.names.add(name);
      continue;
    }
    scanRefs(entry, scan);
  }
}

function defNameFromRef(ref: string): string | null {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) return null;
  const segment = ref.slice(prefix.length).split('/')[0] ?? '';
  return decodePointerSegment(segment);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function trimUnreachableDefs(root: Record<string, unknown>): Record<string, unknown> {
  const defs = isPlainObject(root.$defs) ? root.$defs : undefined;
  if (defs === undefined) return root;

  const scan: RefScan = { names: new Set<string>(), opaque: false };
  scanRefs(root, scan);
  if (scan.opaque) return root;

  const reachable = new Set<string>();
  const pending = [...scan.names];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (reachable.has(name)) continue;
    const def = defs[name];
    if (!isPlainObject(def)) continue;
    reachable.add(name);
    const nested: RefScan = { names: new Set<string>(), opaque: false };
    scanRefs(def, nested);
    if (nested.opaque) return root;
    pending.push(...nested.names);
  }

  const kept: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (reachable.has(name)) kept[name] = def;
  }
  if (Object.keys(kept).length === Object.keys(defs).length) return root;
  const result: Record<string, unknown> = { ...root };
  if (Object.keys(kept).length === 0) delete result.$defs;
  else result.$defs = kept;
  return result;
}
