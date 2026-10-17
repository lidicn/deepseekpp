/**
 * 自然语言 → 自动化 draft（v1.0 · P2）。
 *
 * 管线：instruction → Prompt 构造 →（LLM | 本地规则）→ 严格解码 → 归一化 → 契约校验 → draft。
 * 本模块永不落盘：`createAutomationFromNaturalLanguage` 只产出 draft；
 * 落盘必须由上层拿到用户确认后走 `applyAutomationDraft`，并复用现有
 * CREATE_AUTOMATION 命令契约（`decodeAutomationCreateInput`）。
 */

import type {
  AutomationCreateInput,
  AutomationPromptOptions,
  AutomationSchedule,
  AutomationScheduleKind,
} from './types';

export const DEFAULT_AUTOMATION_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_AUTOMATION_NAME = '自然语言自动化';
export const DEFAULT_MINIMUM_INTERVAL_MINUTES = 1;
export const MANUAL_MINIMUM_INTERVAL_MINUTES = 0;
export const MAX_DRAFT_NAME_LENGTH = 24;

export type AutomationDraftIssueSeverity = 'info' | 'warning' | 'error';

export type AutomationDraftIssueCode =
  | 'instruction_empty'
  | 'llm_output_invalid'
  | 'llm_output_ignored'
  | 'llm_output_failed'
  | 'local_fallback_used'
  | 'name_defaulted'
  | 'prompt_defaulted'
  | 'timezone_defaulted'
  | 'schedule_kind_defaulted'
  | 'schedule_expression_generated'
  | 'schedule_expression_missing'
  | 'schedule_expression_invalid'
  | 'schedule_expression_ignored'
  | 'prompt_options_defaulted'
  | 'contract_violation'
  | 'draft_not_ready'
  | 'unconfirmed'
  | 'apply_failed';

export interface AutomationDraftIssue {
  code: AutomationDraftIssueCode;
  severity: AutomationDraftIssueSeverity;
  message: string;
  field?: string;
}

function issue(
  code: AutomationDraftIssueCode,
  severity: AutomationDraftIssueSeverity,
  message: string,
  field?: string,
): AutomationDraftIssue {
  return field === undefined ? { code, severity, message } : { code, severity, message, field };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * ① Prompt 构造
 * ------------------------------------------------------------------ */

export interface AutomationDraftPromptInput {
  instruction: string;
  now: number;
  timezone: string;
}

export interface AutomationDraftPrompt {
  system: string;
  user: string;
  schema: string;
}

export const AUTOMATION_DRAFT_JSON_SCHEMA = `{
  "name": "string",
  "prompt": "string",
  "schedule": {
    "kind": "manual | cron | rrule",
    "expression": "string | null",
    "timezone": "string",
    "enabled": true,
    "minimumIntervalMinutes": 1
  },
  "promptOptions": {
    "modelType": "string | null",
    "searchEnabled": false,
    "thinkingEnabled": false,
    "refFileIds": []
  },
  "timeExpression": "string",
  "notes": ["string"]
}`;

export function buildAutomationDraftPrompt(input: AutomationDraftPromptInput): AutomationDraftPrompt {
  const system = [
    '你是自动化配置解析器。把用户的中文/英文指令转换成一份自动化草稿配置。',
    '只输出一个 JSON 对象，不要输出解释、markdown 代码块或任何多余文本。',
    '规则：',
    '1. schedule.kind 只能取 manual、cron、rrule；有周期性时间要求时用 cron，并给出标准 5 段 cron（分 时 日 月 周）。',
    '2. 无法确定周期时用 manual，expression 为 null。',
    '3. timezone 使用 IANA 时区名；用户未指定时填 Asia/Shanghai。',
    '4. prompt 是真正要执行的任务描述，去掉时间安排部分。',
    '5. name 是简短名称，不超过 24 个字符。',
    '6. promptOptions 默认 modelType=null、searchEnabled=false、thinkingEnabled=false、refFileIds=[]。',
    '7. timeExpression 原样保留用户表达时间的短语，例如"每天早上9点"。',
    '8. 不要编造 id、时间戳或任何 schema 之外的字段。',
  ].join('\n');

  const user = [
    `当前时间：${new Date(input.now).toISOString()}`,
    `默认时区：${input.timezone}`,
    `用户指令：${input.instruction}`,
    '',
    '输出 JSON schema：',
    AUTOMATION_DRAFT_JSON_SCHEMA,
  ].join('\n');

  return { system, user, schema: AUTOMATION_DRAFT_JSON_SCHEMA };
}

/* ------------------------------------------------------------------ *
 * ③ LLM 输出解码（严格）
 * ------------------------------------------------------------------ */

const JSON_FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/i;

export interface AutomationDraftProposal {
  name?: string;
  prompt?: string;
  schedule?: Partial<AutomationSchedule>;
  promptOptions?: Partial<AutomationPromptOptions>;
  timeExpression?: string;
  timezone?: string;
  notes?: string[];
}

export type AutomationDraftPayloadDecodeResult =
  | { ok: true; proposal: AutomationDraftProposal; issues: readonly AutomationDraftIssue[] }
  | { ok: false; issues: readonly AutomationDraftIssue[] };

export function extractJsonEnvelope(
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: false, message: 'LLM output is empty.' };
  const fenced = JSON_FENCE_RE.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { ok: false, message: 'LLM output does not contain a JSON object.' };
  }
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, message: `LLM output is not valid JSON: ${errorMessage(error)}` };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function decodeAutomationDraftPayload(value: unknown): AutomationDraftPayloadDecodeResult {
  const issues: AutomationDraftIssue[] = [];
  let payload: unknown = value;

  if (typeof value === 'string') {
    const extracted = extractJsonEnvelope(value);
    if (!extracted.ok) {
      return { ok: false, issues: [issue('llm_output_invalid', 'error', extracted.message)] };
    }
    payload = extracted.value;
  }

  if (!isPlainRecord(payload)) {
    return {
      ok: false,
      issues: [issue('llm_output_invalid', 'error', 'LLM output must be a JSON object.')],
    };
  }

  const record = payload;
  const proposal: AutomationDraftProposal = {};

  // name
  if (typeof record.name === 'string' && record.name.trim()) {
    proposal.name = record.name.trim().slice(0, MAX_DRAFT_NAME_LENGTH);
  } else if ('name' in record) {
    issues.push(issue('llm_output_invalid', 'warning', 'name is not a non-empty string; ignored.', 'name'));
  }

  // prompt
  if (typeof record.prompt === 'string' && record.prompt.trim()) {
    proposal.prompt = record.prompt.trim();
  } else if ('prompt' in record) {
    issues.push(issue('llm_output_invalid', 'warning', 'prompt is not a non-empty string; ignored.', 'prompt'));
  }

  // schedule
  if (isPlainRecord(record.schedule)) {
    const schedule: Partial<AutomationSchedule> = {};
    const kind = record.schedule.kind;
    if (kind === 'manual' || kind === 'cron' || kind === 'rrule') {
      schedule.kind = kind;
    } else if ('kind' in record.schedule) {
      issues.push(issue('llm_output_invalid', 'warning', 'schedule.kind is invalid; ignored.', 'schedule.kind'));
    }
    if (typeof record.schedule.expression === 'string' || record.schedule.expression === null) {
      schedule.expression = record.schedule.expression;
    } else if ('expression' in record.schedule) {
      issues.push(issue('llm_output_invalid', 'warning', 'schedule.expression is invalid; ignored.', 'schedule.expression'));
    }
    if (typeof record.schedule.timezone === 'string' && record.schedule.timezone.trim()) {
      schedule.timezone = record.schedule.timezone.trim();
    } else if ('timezone' in record.schedule) {
      issues.push(issue('llm_output_invalid', 'warning', 'schedule.timezone is invalid; ignored.', 'schedule.timezone'));
    }
    if (typeof record.schedule.enabled === 'boolean') {
      schedule.enabled = record.schedule.enabled;
    } else if ('enabled' in record.schedule) {
      issues.push(issue('llm_output_invalid', 'warning', 'schedule.enabled is invalid; ignored.', 'schedule.enabled'));
    }
    if (typeof record.schedule.minimumIntervalMinutes === 'number' && record.schedule.minimumIntervalMinutes >= 0) {
      schedule.minimumIntervalMinutes = record.schedule.minimumIntervalMinutes;
    } else if ('minimumIntervalMinutes' in record.schedule) {
      issues.push(issue('llm_output_invalid', 'warning', 'schedule.minimumIntervalMinutes is invalid; ignored.', 'schedule.minimumIntervalMinutes'));
    }
    proposal.schedule = schedule;
  } else if ('schedule' in record) {
    issues.push(issue('llm_output_invalid', 'warning', 'schedule is not an object; ignored.', 'schedule'));
  }

  // promptOptions
  if (isPlainRecord(record.promptOptions)) {
    const promptOptions: Partial<AutomationPromptOptions> = {};
    if (typeof record.promptOptions.modelType === 'string' || record.promptOptions.modelType === null) {
      promptOptions.modelType = record.promptOptions.modelType;
    } else if ('modelType' in record.promptOptions) {
      issues.push(issue('llm_output_invalid', 'warning', 'promptOptions.modelType is invalid; ignored.', 'promptOptions.modelType'));
    }
    if (typeof record.promptOptions.searchEnabled === 'boolean') {
      promptOptions.searchEnabled = record.promptOptions.searchEnabled;
    } else if ('searchEnabled' in record.promptOptions) {
      issues.push(issue('llm_output_invalid', 'warning', 'promptOptions.searchEnabled is invalid; ignored.', 'promptOptions.searchEnabled'));
    }
    if (typeof record.promptOptions.thinkingEnabled === 'boolean') {
      promptOptions.thinkingEnabled = record.promptOptions.thinkingEnabled;
    } else if ('thinkingEnabled' in record.promptOptions) {
      issues.push(issue('llm_output_invalid', 'warning', 'promptOptions.thinkingEnabled is invalid; ignored.', 'promptOptions.thinkingEnabled'));
    }
    if (Array.isArray(record.promptOptions.refFileIds)) {
      promptOptions.refFileIds = record.promptOptions.refFileIds.filter((x): x is string => typeof x === 'string');
    } else if ('refFileIds' in record.promptOptions) {
      issues.push(issue('llm_output_invalid', 'warning', 'promptOptions.refFileIds is invalid; ignored.', 'promptOptions.refFileIds'));
    }
    proposal.promptOptions = promptOptions;
  } else if ('promptOptions' in record) {
    issues.push(issue('llm_output_invalid', 'warning', 'promptOptions is not an object; ignored.', 'promptOptions'));
  }

  // timeExpression
  if (typeof record.timeExpression === 'string' && record.timeExpression.trim()) {
    proposal.timeExpression = record.timeExpression.trim();
  }

  // timezone（顶层）
  if (typeof record.timezone === 'string' && record.timezone.trim()) {
    proposal.timezone = record.timezone.trim();
  }

  // notes
  if (Array.isArray(record.notes)) {
    proposal.notes = record.notes.filter((x): x is string => typeof x === 'string');
  }

  return { ok: true, proposal, issues };
}

/* ------------------------------------------------------------------ *
 * ④ 本地规则兜底
 * ------------------------------------------------------------------ */

export interface ParsedTimeSchedule {
  kind: AutomationScheduleKind;
  expression: string | null;
  timeExpression: string;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function parseTimeOfDay(raw: string): TimeOfDay | null {
  const text = raw.trim();
  if (!text) return null;

  // 匹配 "早上9点"、"晚上8点半"、"下午3:30" 等
  // R-9: 带时段的正则必须排在最前——否则 24h 正则会先命中 "下午3:30" 里的 "3:30"，
  // 时段前缀被吞、建出 03:30 而非 15:30。数组顺序已按此重排（0=时段 / 1=24h / 2=数字+半）。
  const patterns = [
    // 早上/上午/中午/下午/晚上 + 数字点/半
    /(早上|上午|中午|下午|傍晚|晚上|凌晨)\s*(\d{1,2})\s*(点|:|：)\s*(\d{1,2})?\s*(分|半)?/,
    // 24小时制：19点18分、19:18、19点
    /(\d{1,2})\s*(点|:|：)\s*(\d{1,2})\s*分?/,
    // 数字点 + 半
    /(\d{1,2})\s*(点|:|：)\s*(\d{1,2})?\s*(分|半)?/,
  ];

  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
    const pattern = patterns[patternIndex];
    const match = pattern.exec(text);
    if (!match) continue;

    let hour: number;
    let minute = 0;

    if (patternIndex === 1) {
      // 24小时制：19点18分、19:18、19点
      const h = parseInt(match[1], 10);
      const m = match[3] ? parseInt(match[3], 10) : 0;
      if (isNaN(h) || h < 0 || h > 23) continue;
      if (!isNaN(m) && (m < 0 || m > 59)) continue;
      hour = h;
      minute = m;
    } else if (patternIndex === 0) {
      // 带时段的匹配
      const period = match[1];
      const h = parseInt(match[2], 10);
      const m = match[4] ? parseInt(match[4], 10) : 0;
      const half = match[5] === '半';

      if (isNaN(h) || h < 1 || h > 12) continue;
      if (!isNaN(m) && (m < 0 || m > 59)) continue;

      // 时段换算
      if (period === '下午' || period === '傍晚') {
        hour = h < 12 ? h + 12 : h;
      } else if (period === '晚上') {
        hour = h < 12 ? h + 12 : h;
      } else if (period === '凌晨') {
        hour = h;
      } else {
        // 早上/上午/中午
        hour = h === 12 ? (period === '中午' ? 12 : 0) : h;
      }

      minute = half ? 30 : m;
    } else {
      // 不带时段的匹配
      const h = parseInt(match[1], 10);
      const m = match[3] ? parseInt(match[3], 10) : 0;
      const half = match[4] === '半';

      if (isNaN(h) || h < 0 || h > 23) continue;
      if (!isNaN(m) && (m < 0 || m > 59)) continue;

      hour = h;
      minute = half ? 30 : m;
    }

    return { hour, minute };
  }

  return null;
}

export function isStructurallyValidCron(expression: string): boolean {
  if (!expression || typeof expression !== 'string') return false;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  // 简单校验：每段都是数字、*、/、-、, 之一
  const validPart = /^(\*|\d+(\/\d+)?|\d+-\d+(\/\d+)?|\d+(,\d+)*)$/;
  for (const part of parts) {
    if (!validPart.test(part)) return false;
  }

  return true;
}

export function deriveScheduleFromTimeExpression(raw: string): ParsedTimeSchedule | null {
  const text = raw.trim();
  if (!text) return null;

  // 匹配 "每天X点"
  const dailyMatch = /(每天|每日)\s*(.+)/.exec(text);
  if (dailyMatch) {
    const time = parseTimeOfDay(dailyMatch[2]);
    if (time) {
      return {
        kind: 'cron',
        expression: `${time.minute} ${time.hour} * * *`,
        timeExpression: text,
      };
    }
  }

  // 匹配 "每周X"
  const weeklyMatch = /(每周|每星期)\s*(一|二|三|四|五|六|日|天|1|2|3|4|5|6|7)\s*(.+)?/.exec(text);
  if (weeklyMatch) {
    const dayMap: Record<string, number> = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0,
    };
    const dayOfWeek = dayMap[weeklyMatch[2]];
    if (dayOfWeek !== undefined) {
      const timeText = weeklyMatch[3] ?? '9点';
      const time = parseTimeOfDay(timeText);
      if (time) {
        return {
          kind: 'cron',
          expression: `${time.minute} ${time.hour} * * ${dayOfWeek}`,
          timeExpression: text,
        };
      }
    }
  }

  // 匹配 "手动" / "立即" / "一次"
  if (/手动|立即|一次|马上/.test(text)) {
    return {
      kind: 'manual',
      expression: null,
      timeExpression: text,
    };
  }

  // 匹配 "今晚X点X分"、"明天X点"、"今天X点" 等一次性时间
  // 注意：cron 不支持一次性任务，所以这些都用 manual，但记录 timeExpression
  const oneTimeMatch = /(今晚|明天|今天|后天|大后天)\s*(.+)?/.exec(text);
  if (oneTimeMatch) {
    const timeText = oneTimeMatch[2] ?? '';
    const time = parseTimeOfDay(timeText);
    if (time) {
      return {
        kind: 'manual',
        expression: null,
        timeExpression: `${oneTimeMatch[1]} ${timeText}`.trim(),
      };
    }
  }

  // 匹配纯时间："19点18分"、"9点半"
  const pureTimeMatch = /^(\d{1,2})\s*(点|:|：)\s*(\d{1,2})\s*分?$/.exec(text);
  if (pureTimeMatch) {
    const time = parseTimeOfDay(text);
    if (time) {
      return {
        kind: 'manual',
        expression: null,
        timeExpression: text,
      };
    }
  }

  return null;
}

export interface LocalAutomationParseResult {
  proposal: AutomationDraftProposal;
  issues: readonly AutomationDraftIssue[];
}

export function parseAutomationInstructionLocal(
  instruction: string,
  options?: { defaultTimezone?: string },
): LocalAutomationParseResult {
  const issues: AutomationDraftIssue[] = [];
  const proposal: AutomationDraftProposal = {};

  const text = instruction.trim();
  if (!text) {
    return {
      proposal,
      issues: [issue('instruction_empty', 'error', 'Instruction is empty.')],
    };
  }

  // 尝试从指令中提取时间表达式
  const schedule = deriveScheduleFromTimeExpression(text);
  if (schedule) {
    proposal.schedule = {
      kind: schedule.kind,
      expression: schedule.expression,
      timezone: options?.defaultTimezone ?? DEFAULT_AUTOMATION_TIMEZONE,
      enabled: true,
      minimumIntervalMinutes: schedule.kind === 'manual' ? MANUAL_MINIMUM_INTERVAL_MINUTES : DEFAULT_MINIMUM_INTERVAL_MINUTES,
    };
    proposal.timeExpression = schedule.timeExpression;
    issues.push(issue('schedule_expression_generated', 'info', `Generated cron expression: ${schedule.expression ?? 'manual'}`));
  } else {
    // 无法解析时间 → 手动
    proposal.schedule = {
      kind: 'manual',
      expression: null,
      timezone: options?.defaultTimezone ?? DEFAULT_AUTOMATION_TIMEZONE,
      enabled: true,
      minimumIntervalMinutes: MANUAL_MINIMUM_INTERVAL_MINUTES,
    };
    issues.push(issue('schedule_kind_defaulted', 'info', 'Could not parse time expression; defaulted to manual.'));
  }

  // prompt：去掉时间部分后的剩余文本（简单实现）
  const promptText = text
    .replace(/(每天|每日|每周|每星期|手动|立即|一次|马上).+/, '')
    .trim();
  if (promptText) {
    proposal.prompt = promptText;
  } else {
    proposal.prompt = text;
    issues.push(issue('prompt_defaulted', 'warning', 'Could not extract prompt; using full instruction.'));
  }

  // name：取前几个字
  proposal.name = text.slice(0, MAX_DRAFT_NAME_LENGTH);
  issues.push(issue('name_defaulted', 'info', `Auto-generated name: ${proposal.name}`));

  // promptOptions 默认值
  proposal.promptOptions = {
    modelType: null,
    searchEnabled: false,
    thinkingEnabled: false,
    refFileIds: [],
  };
  issues.push(issue('prompt_options_defaulted', 'info', 'Using default promptOptions.'));

  issues.push(issue('local_fallback_used', 'info', 'Used local rule parser (no LLM).'));

  return { proposal, issues };
}

/* ------------------------------------------------------------------ *
 * ⑤⑥ 归一化 + 契约校验
 * ------------------------------------------------------------------ */

export interface AutomationDraft {
  createInput: AutomationCreateInput;
  ready: boolean;
  issues: readonly AutomationDraftIssue[];
}

export interface AutomationDraftNormalizeOptions {
  defaultTimezone?: string;
}

export function normalizeAutomationDraft(
  proposal: AutomationDraftProposal,
  options?: AutomationDraftNormalizeOptions,
): AutomationDraft {
  const issues: AutomationDraftIssue[] = [];
  const defaultTimezone = options?.defaultTimezone ?? DEFAULT_AUTOMATION_TIMEZONE;

  // name
  let name = proposal.name?.trim() ?? '';
  if (!name) {
    name = DEFAULT_AUTOMATION_NAME;
    issues.push(issue('name_defaulted', 'info', `Name missing; defaulted to: ${name}`, 'name'));
  }

  // prompt
  let prompt = proposal.prompt?.trim() ?? '';
  if (!prompt) {
    prompt = '请执行任务。';
    issues.push(issue('prompt_defaulted', 'warning', 'Prompt missing; defaulted.', 'prompt'));
  }

  // schedule
  const scheduleKind = proposal.schedule?.kind ?? 'manual';
  let scheduleExpression = proposal.schedule?.expression ?? null;
  const scheduleTimezone = proposal.schedule?.timezone?.trim() ?? proposal.timezone?.trim() ?? defaultTimezone;
  const scheduleEnabled = proposal.schedule?.enabled ?? true;
  const scheduleMinimumIntervalMinutes = proposal.schedule?.minimumIntervalMinutes
    ?? (scheduleKind === 'manual' ? MANUAL_MINIMUM_INTERVAL_MINUTES : DEFAULT_MINIMUM_INTERVAL_MINUTES);

  if (scheduleKind === 'cron' && scheduleExpression) {
    if (!isStructurallyValidCron(scheduleExpression)) {
      issues.push(issue('schedule_expression_invalid', 'error', `Cron expression is invalid: ${scheduleExpression}`, 'schedule.expression'));
      scheduleExpression = null;
    }
  }

  if (scheduleKind === 'manual' && scheduleExpression !== null) {
    issues.push(issue('schedule_expression_ignored', 'warning', 'Manual schedule; expression ignored.', 'schedule.expression'));
    scheduleExpression = null;
  }

  // promptOptions
  const promptOptions: AutomationPromptOptions = {
    modelType: proposal.promptOptions?.modelType ?? null,
    searchEnabled: proposal.promptOptions?.searchEnabled ?? false,
    thinkingEnabled: proposal.promptOptions?.thinkingEnabled ?? false,
    refFileIds: proposal.promptOptions?.refFileIds ?? [],
  };

  if (!proposal.promptOptions) {
    issues.push(issue('prompt_options_defaulted', 'info', 'Using default promptOptions.'));
  }

  const createInput: AutomationCreateInput = {
    name,
    prompt,
    schedule: {
      kind: scheduleKind,
      expression: scheduleExpression,
      timezone: scheduleTimezone,
      enabled: scheduleEnabled,
      minimumIntervalMinutes: scheduleMinimumIntervalMinutes,
    },
    promptOptions,
  };

  // ready：没有 error 级别的 issue
  const ready = !issues.some((i) => i.severity === 'error');

  return { createInput, ready, issues };
}

/* ------------------------------------------------------------------ *
 * ①-⑥ 编排
 * ------------------------------------------------------------------ */

export interface NaturalLanguageCreateRequest {
  instruction: string;
  now?: number;
  timezone?: string;
}

export interface NaturalLanguageCreateDeps {
  // LLM 调用接口（可注入）；未注入则用本地规则兜底
  interpret?: (prompt: AutomationDraftPrompt) => Promise<string>;
}

export type CreateAutomationDraftResult = AutomationDraft;

export async function createAutomationFromNaturalLanguage(
  request: NaturalLanguageCreateRequest,
  deps?: NaturalLanguageCreateDeps,
): Promise<CreateAutomationDraftResult> {
  const now = request.now ?? Date.now();
  const timezone = request.timezone ?? DEFAULT_AUTOMATION_TIMEZONE;
  const instruction = request.instruction.trim();

  if (!instruction) {
    return {
      createInput: {
        name: DEFAULT_AUTOMATION_NAME,
        prompt: '',
        schedule: {
          kind: 'manual',
          expression: null,
          timezone,
          enabled: true,
          minimumIntervalMinutes: MANUAL_MINIMUM_INTERVAL_MINUTES,
        },
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
      },
      ready: false,
      issues: [issue('instruction_empty', 'error', 'Instruction is empty.')],
    };
  }

  // ① 构造 Prompt
  const prompt = buildAutomationDraftPrompt({ instruction, now, timezone });

  let proposal: AutomationDraftProposal;
  const allIssues: AutomationDraftIssue[] = [];

  // ② LLM 调用（如果有）
  if (deps?.interpret) {
    try {
      const raw = await deps.interpret(prompt);
      const decoded = decodeAutomationDraftPayload(raw);
      if (decoded.ok) {
        proposal = decoded.proposal;
        allIssues.push(...decoded.issues);
      } else {
        allIssues.push(...decoded.issues);
        // LLM 失败 → 本地规则兜底
        const local = parseAutomationInstructionLocal(instruction, { defaultTimezone: timezone });
        proposal = local.proposal;
        allIssues.push(...local.issues);
        allIssues.push(issue('llm_output_ignored', 'warning', 'LLM output invalid; fell back to local parser.'));
      }
    } catch (error) {
      allIssues.push(issue('llm_output_failed', 'warning', `LLM call failed: ${errorMessage(error)}`));
      // LLM 失败 → 本地规则兜底
      const local = parseAutomationInstructionLocal(instruction, { defaultTimezone: timezone });
      proposal = local.proposal;
      allIssues.push(...local.issues);
    }
  } else {
    // 无 LLM → 本地规则兜底
    const local = parseAutomationInstructionLocal(instruction, { defaultTimezone: timezone });
    proposal = local.proposal;
    allIssues.push(...local.issues);
  }

  // ⑤⑥ 归一化 + 契约校验
  const draft = normalizeAutomationDraft(proposal, { defaultTimezone: timezone });
  draft.issues = [...allIssues, ...draft.issues];

  return draft;
}

/* ------------------------------------------------------------------ *
 * 确认后落盘
 * ------------------------------------------------------------------ */

export interface ApplyAutomationDraftOptions {
  confirmed: boolean;
  store: {
    createAutomation: (input: AutomationCreateInput) => Promise<unknown>;
  };
}

export type ApplyAutomationDraftResult =
  | { ok: true; automation: unknown }
  | { ok: false; issues: readonly AutomationDraftIssue[] };

export async function applyAutomationDraft(
  draft: AutomationDraft,
  options: ApplyAutomationDraftOptions,
): Promise<ApplyAutomationDraftResult> {
  if (!options.confirmed) {
    return {
      ok: false,
      issues: [issue('unconfirmed', 'error', 'Draft must be confirmed before applying.')],
    };
  }

  if (!draft.ready) {
    return {
      ok: false,
      issues: [...draft.issues, issue('draft_not_ready', 'error', 'Draft is not ready; fix errors first.')],
    };
  }

  try {
    const automation = await options.store.createAutomation(draft.createInput);
    return { ok: true, automation };
  } catch (error) {
    return {
      ok: false,
      issues: [issue('apply_failed', 'error', `Failed to create automation: ${errorMessage(error)}`)],
    };
  }
}
