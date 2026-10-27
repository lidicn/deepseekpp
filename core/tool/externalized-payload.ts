import type { ToolCall, ToolError, ToolPayload } from './types';
import { enforceLocalSkillCwd } from './local-skill-cwd';

const EXTERNALIZED_TOOL_PAYLOAD_MARKER = '__dppExternalToolPayload';
const EXTERNALIZED_TOOL_PAYLOAD_VERSION = 1 as const;
const EXTERNALIZED_TOOL_PAYLOAD_TTL_MS = 30 * 60 * 1000;

/**
 * #84 条目数上限。
 * 定量依据：
 *   - per-entry 上限 8 MiB
 *   - automation 内 tool call 串行执行，一个 call 对应一个 entry（take 后删除）
 *   - TTL 30 min，prune 在每次 append / take 时触发
 *   - 最坏：30 min 内连续 append 而从不 take（模型异常中断）
 *     → 200 entries × 8 MiB = 1.6 GiB（chrome.storage.local 单页理论 5 GiB）
 *   - 正常：一 call 一 take，Map 大小始终 ≤ 并发 call 数（≤ 10）
 * 200 是够用又不至于让异常泄漏无限增长的值。
 */
const EXTERNALIZED_PAYLOAD_MAX_ENTRIES = 200;

export interface ExternalizedToolPayload {
  [key: string]: unknown;
  [EXTERNALIZED_TOOL_PAYLOAD_MARKER]: true;
  version: typeof EXTERNALIZED_TOOL_PAYLOAD_VERSION;
  ref: string;
  invocationName: string;
  createdAt: number;
}

type ExternalizedToolPayloadEntry = {
  invocationName: string;
  chunks: string[];
  totalChars: number;
  createdAt: number;
};

const payloadEntries = new Map<string, ExternalizedToolPayloadEntry>();

// 8 MiB per payload: the streaming parser externalizes bodies above 64K and
// caps them at ~1 MiB (STREAM_TOOL_BODY_MAX_CHARS), so this budget only trips
// on a chunk flood.
const EXTERNALIZED_PAYLOAD_MAX_CHARS = 8 * 1024 * 1024;

export function chainExternalizedPayloadWrite(
  previous: Promise<void>,
  write: () => Promise<void>,
): Promise<void> {
  // A missing middle chunk can still leave syntactically valid JSON. Keep the
  // first failure sticky so execution observes it and never rehydrates a
  // silently truncated payload.
  return previous.then(write);
}

export function createExternalizedToolPayload(ref: string, invocationName: string): ExternalizedToolPayload {
  return {
    [EXTERNALIZED_TOOL_PAYLOAD_MARKER]: true,
    version: EXTERNALIZED_TOOL_PAYLOAD_VERSION,
    ref,
    invocationName,
    createdAt: Date.now(),
  };
}

export function isExternalizedToolPayload(value: unknown): value is ExternalizedToolPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload[EXTERNALIZED_TOOL_PAYLOAD_MARKER] === true &&
    payload.version === EXTERNALIZED_TOOL_PAYLOAD_VERSION &&
    typeof payload.ref === 'string' &&
    typeof payload.invocationName === 'string' &&
    typeof payload.createdAt === 'number';
}

export function isExternalizedToolPayloadCall(call: ToolCall): boolean {
  return isExternalizedToolPayload(call.payload);
}

export function appendExternalizedToolPayloadChunk(
  ref: string,
  invocationName: string,
  chunk: string,
  namespace?: string,
): void {
  pruneExpiredExternalizedPayloads();
  const key = createPayloadEntryKey(ref, namespace);
  const existing = payloadEntries.get(key);
  if (existing) {
    if (existing.invocationName !== invocationName) {
      throw new Error(`Externalized tool payload ${ref} is already bound to another invocation.`);
    }
    existing.totalChars += chunk.length;
    // Budget check: streaming externalization caps a single call body well
    // below this, so an over-budget entry means a flood of chunks (M1).
    if (existing.totalChars > EXTERNALIZED_PAYLOAD_MAX_CHARS) {
      throw new Error(`Externalized tool payload ${ref} exceeded ${EXTERNALIZED_PAYLOAD_MAX_CHARS} chars.`);
    }
    existing.chunks.push(chunk);
    return;
  }

  // #84 条目数硬上限 — 超上限立即拒绝（不能静默）。
  if (payloadEntries.size >= EXTERNALIZED_PAYLOAD_MAX_ENTRIES) {
    throw new Error(`Externalized payload pool exhausted (${EXTERNALIZED_PAYLOAD_MAX_ENTRIES} entries); cannot create new entry for ${ref}.`);
  }

  // 审计 #48：首个 chunk 也要检查预算（原只在追加时查，首 chunk 超限直接建条目）。
  if (chunk.length > EXTERNALIZED_PAYLOAD_MAX_CHARS) {
    throw new Error(`Externalized tool payload ${ref} first chunk ${chunk.length} exceeds ${EXTERNALIZED_PAYLOAD_MAX_CHARS} chars.`);
  }
  payloadEntries.set(key, {
    invocationName,
    chunks: [chunk],
    totalChars: chunk.length,
    createdAt: Date.now(),
  });
}

export function takeExternalizedToolPayloadText(
  ref: string,
  invocationName: string,
  namespace?: string,
): string | null {
  pruneExpiredExternalizedPayloads();
  const key = createPayloadEntryKey(ref, namespace);
  const entry = payloadEntries.get(key);
  if (!entry) return null;
  // 审计 #47 复核（PM，2026-10-27）：判为**假阳性**，恢复 one-shot 语义。
  // 依据：`tests/prompt-output-contract.test.ts` 有一条 2026-07-13 `0551eef
  // (test: freeze prompt output contracts)` 引入的**冻结契约**测试：
  //   「freezes one-shot deletion after an externalized payload name mismatch」
  //   名字不匹配取过一次之后，即使再用**正确**名字取也必须返回 null。
  // 这是有意的安全语义（一次性消费，防错名探针后再按正确名捞走），
  // 不是"条目被吞"。审计只看到"先删后校验"的顺序，没看到这条契约。
  payloadEntries.delete(key);
  if (entry.invocationName !== invocationName) return null;
  return entry.chunks.join('');
}

export function clearExternalizedToolPayloadNamespace(namespace: string): void {
  const prefix = `${namespace}\u0000`;
  for (const key of payloadEntries.keys()) {
    if (key.startsWith(prefix)) payloadEntries.delete(key);
  }
}

export function parseExternalizedToolPayload(
  body: string,
  invocationName: string,
  skillDir?: string,
): { payload: ToolPayload | null; parseError?: ToolError } {
  try {
    const parsed = body.length === 0 ? {} : JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        payload: null,
        parseError: createExternalizedToolParseError(
          invocationName,
          'Tool call body must be a JSON object.',
        ),
      };
    }
    return { payload: enforceLocalSkillCwd(parsed as ToolPayload, invocationName, skillDir) };
  } catch (error) {
    return {
      payload: null,
      parseError: createExternalizedToolParseError(
        invocationName,
        [
          'Tool call body is not valid JSON.',
          'Use double quotes for strings and escape backslashes in local file paths, for example "D:\\\\project\\\\file.txt" or "D:/project/file.txt".',
          error instanceof Error ? error.message : String(error),
        ].join(' '),
      ),
    };
  }
}

function createExternalizedToolParseError(
  invocationName: string,
  message: string,
): ToolError {
  return {
    code: 'tool_call_external_payload_invalid',
    message,
    retryable: false,
    details: { invocationName },
  };
}

function pruneExpiredExternalizedPayloads(): void {
  const now = Date.now();
  for (const [ref, entry] of payloadEntries.entries()) {
    if (now - entry.createdAt > EXTERNALIZED_TOOL_PAYLOAD_TTL_MS) {
      payloadEntries.delete(ref);
    }
  }
}

function createPayloadEntryKey(ref: string, namespace?: string): string {
  return namespace ? `${namespace}\u0000${ref}` : ref;
}
