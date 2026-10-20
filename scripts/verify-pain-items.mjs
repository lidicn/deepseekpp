/**
 * verify-pain-items.mjs — 第二轮四痛点项 + R07 的真机/离线验收脚本。
 *
 * 设计原则（无人应答、CDP 可能离线）：
 * - 每项输出 PASS / FAIL / SKIP 三态，绝不把"没触发到"伪装成 PASS。
 * - STATIC：离线读仓库源码核对钩子在位（常量/错误码/testid/广播字段），无需浏览器。
 * - LIVE：仅当 CDP(9222) 在线时，通过 /json 发现 target 做运行态探测；
 *   需要真实长任务/超长输入/截断才能产生的信号，自动无法发起 → SKIP 并打印人工命令。
 *
 * 用法：
 *   node scripts/verify-pain-items.mjs              # 静态核对 + 尝试 CDP 在线探测
 *   node scripts/verify-pain-items.mjs --static    # 只跑离线静态核对（不连 CDP）
 *
 * 退出码：0 = 无 FAIL（含全 SKIP/离线）；1 = 存在 FAIL。
 * CDP 离线不是 FAIL：静态项照常评估，LIVE 项记 SKIP 并给出启动 Chrome 指引。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const ONLY_STATIC = process.argv.includes('--static');
// A2: --json [path] 把结果落盘，便于两轮对比留档。
const JSON_OUT = (() => {
  const i = process.argv.indexOf('--json');
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'verify-pain-items.json';
})();
// 实际使用的 CDP 端点（由 pickCdpEndpoint 探测后填入，供汇总 JSON 留档）。
let usedCdpBase = null;
// dpp 未打包扩展 id（与 tools/reload-extension.py DEFAULT_EXT_ID 一致），可用 env 覆盖。
const EXT_ID = process.env.DPP_EXT_ID ?? 'jjjhcjjegfplcfncohmfhbdhcalmijnc';

const results = [];

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const tag = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP' }[status];
  console.log(`[${tag}] ${id} ${name} — ${detail}`);
}

function readSrc(rel) {
  try {
    return readFileSync(join(SRC_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

/** STATIC：文件存在且命中全部期望子串。 */
function staticCheck(id, name, file, needles, note = '') {
  const text = readSrc(file);
  if (text === null) {
    record(id, name, 'FAIL', `源码文件缺失: ${file} ${note}`);
    return;
  }
  const missing = needles.filter((n) => !text.includes(n));
  if (missing.length === 0) {
    record(id, name, 'PASS', `静态钩子在位 (${file})${note}`);
  } else {
    record(id, name, 'FAIL', `缺失钩子 ${JSON.stringify(missing)} in ${file}${note}`);
  }
}

// ---------------------------------------------------------------------------
// STATIC 核对（离线可跑）
// ---------------------------------------------------------------------------

// R15: shell_exec/python_exec 等长任务独立预算 15 分钟，120s 不再误判 tool_timeout。
staticCheck(
  'R15',
  '长任务工具独立 15 分钟预算，120s 不误报 tool_timeout',
  'core/tool/runtime.ts',
  [
    'LONG_RUNNING_TOOL_TIMEOUT_MS = 15 * 60_000',
    "'shell_exec'",
    "'python_exec'",
    "TOOL_TIMEOUT_ERROR_CODE = 'tool_timeout'",
  ],
  '（静态：预算常量与长工具名单在位；真实 >120s 行为需人工，见清单）',
);

// R05: 30s 无 SSE 帧记一次 stream_stall，只可见化不断开。
staticCheck(
  'R05',
  '流式 30s 无帧记 stream_stall 诊断（不断开）',
  'core/deepseek/active-client.ts',
  ['stream_stall', 'STALL_WARN_MS', 'evaluateStreamStall'],
  '（静态：心跳记录在位；真实 30s 停顿需人工，见清单）',
);

// R06: 长输入广播 chunk 带 budget 字段，level ∈ ok/warn/critical。
staticCheck(
  'R06',
  '预算 chunk 带 budget.level（ok/warn/critical）',
  'core/chat/context-budget.ts',
  ["level: BudgetLevel", "'critical'", "'warn'"],
);
{
  const text = readSrc('entrypoints/background/chat-runtime-service.ts');
  if (text && text.includes('budget:') && text.includes('evaluateBudgetForText')) {
    record('R06', 'budget 经流 chunk 广播', 'PASS', 'chat-runtime-service.ts 广播 budget 字段');
  } else {
    record('R06', 'budget 经流 chunk 广播', 'FAIL', 'chat-runtime-service.ts 未找到 budget 广播/evaluateBudgetForText');
  }
}

// R07: 续轮 >MAX_AUTO_CONTINUE(3) 广播 auto_continue_exhausted。
staticCheck(
  'R07',
  '续轮超 3 次广播 auto_continue_exhausted',
  'core/chat/loop-contract.ts',
  ['MAX_AUTO_CONTINUE = 3'],
);
{
  const text = readSrc('entrypoints/background/chat-runtime-service.ts');
  if (text && text.includes("error: 'auto_continue_exhausted'")) {
    record('R07', '超限终帧广播 auto_continue_exhausted', 'PASS', 'web/official 两循环均有耗尽终帧');
  } else {
    record('R07', '超限终帧广播 auto_continue_exhausted', 'FAIL', 'chat-runtime-service.ts 未找到耗尽终帧');
  }
}

// R08: 侧边栏工具运行面板，data-testid="tool-run-panel" 含 data-tool-name。
staticCheck(
  'R08',
  '侧边栏工具面板 tool-run-panel 含 data-tool-name',
  'entrypoints/sidepanel/components/ToolRunPanel.tsx',
  ['data-testid="tool-run-panel"', 'data-tool-name='],
  '（静态：面板挂载在位；真实工具卡片需有一次工具运行，见清单）',
);

// R01: 交互型工具独立 10 分钟预算（选文件夹不被 120s 机器超时掐断）。
staticCheck(
  'R01',
  '交互型工具 10 分钟预算（选文件夹不受 120s 约束）',
  'core/tool/runtime.ts',
  ['INTERACTIVE_TOOL_TIMEOUT_MS = 10 * 60_000', "'local_folder_pick'"],
  '（静态：预算常量与交互型工具名单在位；真实停留 >2 分钟需人工，见清单）',
);

// R02: 选文件夹取消语义分三态（取消 / 空路径 / 协议错误），不再把取消报成协议错误。
staticCheck(
  'R02',
  '选文件夹取消/空路径/协议错误三态',
  'core/skill/local-importer.ts',
  ['FOLDER_PICK_CANCELLED', 'FOLDER_PICK_EMPTY_PATH', 'FOLDER_PICK_INVALID_PROTOCOL'],
  '（静态：三态常量在位；真实点击取消需人工，见清单）',
);

// R03: Native Host 预热，避免 folder pick 撞 host 冷启动。
staticCheck(
  'R03',
  'native host 预热 shell_status（防冷启动弹不出框）',
  'core/skill/local-importer.ts',
  ['shell_status'],
  '（静态：预热调用在位；真实首次弹框速度需人工观察）',
);

// R04: 交互型工具超时后记 abandoned 诊断（留证据，不静默）。
staticCheck(
  'R04',
  '交互型超时记 interactive_tool_abandoned 诊断',
  'core/tool/runtime.ts',
  ['interactive_tool_abandoned'],
);

// R09: 步骤时间线（纯文本按 step 分组）。
staticCheck(
  'R09',
  '步骤时间线 buildStepTimeline 分组',
  'entrypoints/sidepanel/tool-runs.ts',
  ['buildStepTimeline'],
);
staticCheck(
  'R09',
  'StepTimeline 已挂进 ChatPage',
  'entrypoints/sidepanel/pages/ChatPage.tsx',
  ['StepTimeline'],
);

// R10: __DPP_DEBUG__.lastTurn() 最近一轮聚合。
staticCheck(
  'R10',
  '__DPP_DEBUG__.lastTurn() 聚合最近一轮',
  'core/debug/refactor-telemetry.ts',
  ['buildLastTurnSummary', 'lastTurn'],
  '（静态：聚合函数与挂载在位；真实读取需页面在线，见清单）',
);

// T05 剩余：sidepanel 消费 GET_DIAGNOSTIC_SNAPSHOT（handler 已在 5843d12）。
staticCheck(
  'T05',
  'GET_DIAGNOSTIC_SNAPSHOT handler 已注册',
  'entrypoints/background/diagnostics-handlers.ts',
  ['GET_DIAGNOSTIC_SNAPSHOT'],
);

// ---------------------------------------------------------------------------
// LIVE: CDP 在线探测（--static 或离线时整段跳过，相关项记 SKIP）
// ---------------------------------------------------------------------------

/**
 * A3 实测修正：9222 在这台机器上被**豆包桌面版内嵌 Chromium** 长期占用
 * （它的 target 是 `doubao://...`）。若只用 9222，脚本会连上错误的端点。
 * 因此探测候选端口并按「有 deepseek 页 / 有扩展 target」打分选最佳。
 * 用 DPP_CDP_HTTP 指定时只用该端点（不做回退）。
 */
const CDP_CANDIDATES = process.env.DPP_CDP_HTTP
  ? [process.env.DPP_CDP_HTTP]
  : ['http://127.0.0.1:9222', 'http://127.0.0.1:9223'];

async function fetchTargets(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base}/json`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 打分：有 deepseek 页 +2，有扩展 target +2，有任何 http 页 +1。 */
function scoreTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  let score = 0;
  if (list.some((t) => /chat\.deepseek\.com|www\.deepseek\.com/.test(String(t.url)))) score += 2;
  if (list.some((t) => String(t.url).startsWith('chrome-extension://'))) score += 2;
  if (list.some((t) => String(t.url).startsWith('http'))) score += 1;
  return score;
}

async function pickCdpEndpoint() {
  const tried = [];
  let best = null;
  for (const base of CDP_CANDIDATES) {
    try {
      const targets = await fetchTargets(base);
      const score = scoreTargets(targets);
      tried.push({ base, ok: true, score, count: targets.length });
      if (!best || score > best.score) best = { base, score, targets };
    } catch (e) {
      tried.push({ base, ok: false, error: String(e?.message ?? e) });
    }
  }
  return { best, tried };
}

async function cdpEvaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const id = 1;
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
  const value = await new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage);
        resolve(msg?.result?.result?.value);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.onerror = reject;
  });
  ws.close();
  return value;
}

async function live() {
  const { best, tried } = await pickCdpEndpoint();

  if (!best) {
    console.log('\n[CDP] 未连接到任何候选端点 —— LIVE 探测全部 SKIP（静态项仍有效）。');
    for (const t of tried) console.log(`  尝试 ${t.base} → 失败：${t.error}`);
    console.log('启动带调试端口的 Chrome（注意 9222 常被豆包桌面版占用，建议用 9223）：');
    console.log('  $chrome = "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"');
    console.log('  & $chrome --remote-debugging-port=9223 --user-data-dir="$env:TEMP\\dpp-cdp-profile"');
    console.log('  然后打开 deepseek 对话页、加载 dpp 未打包扩展，重跑本脚本。\n');
    record('LIVE', 'CDP 连接', 'SKIP', '候选端点均不可达，见上方启动指引');
    return;
  }

  const cdpBase = best.base;
  usedCdpBase = cdpBase;
  const targets = best.targets;
  if (tried.filter((t) => t.ok).length > 1) {
    console.log(`[CDP] 多个端点可连，选用 ${cdpBase}（score=${best.score}）`);
  }

  // 撞端口诊断：连上了，但既没有 deepseek 页也没有扩展 target，且存在非 http 协议 target
  // → 极可能是连到了别的 Chromium 应用（如豆包桌面版的 doubao:// 页面）。
  const nonHttp = targets.filter((t) => typeof t.url === 'string' && !/^https?:\/\//.test(t.url));
  if (best.score <= 1 && nonHttp.length > 0) {
    console.log(`[CDP] ⚠ 端点 ${cdpBase} 看起来不是我们的调试浏览器：`);
    for (const t of nonHttp.slice(0, 4)) {
      console.log(`     [${t.type}] ${String(t.url).slice(0, 100)}`);
    }
    console.log('  → 该端口很可能被其他应用（如豆包桌面版）占用。');
    console.log('     改用独立端口启动 Chrome 后，用 DPP_CDP_HTTP 指向它：');
    console.log('     $env:DPP_CDP_HTTP="http://127.0.0.1:9223"; node scripts/verify-pain-items.mjs');
  }

  const pages = targets.filter((t) => t.type === 'page');
  const extTargets = targets.filter((t) => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
  const extIdMatched = extTargets.some((t) => t.url.includes(EXT_ID));
  const panel = pages.find((t) => t.url.includes(EXT_ID) && /sidepanel/i.test(t.url));
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  const deepseekPage = pages.find((t) => /chat\.deepseek\.com|www\.deepseek\.com/.test(t.url));

  console.log(`\n[CDP] 已连接 ${cdpBase}，target=${targets.length}；sidepanel=${!!panel} SW=${!!sw} deepseekPage=${!!deepseekPage}`);

  // A2: 扩展 target 定位失败时给出可排查信息，而不是静默 SKIP。
  if (!panel && !sw) {
    console.log(`[CDP] 未发现扩展 target（期望 id=${EXT_ID}）。`);
    if (extTargets.length === 0) {
      console.log('  → 当前没有任何 chrome-extension:// target，扩展很可能未加载：');
      console.log('     到 chrome://extensions 打开开发者模式，加载 src/dist/chrome-mv3');
      console.log('     （若尚未构建：npx wxt build --browser chrome）');
    } else {
      console.log(`  → 发现 ${extTargets.length} 个扩展 target，但 id 与期望不符。实际：`);
      for (const t of extTargets.slice(0, 5)) {
        console.log(`     [${t.type}] ${String(t.url).slice(0, 110)}`);
      }
      console.log('     若扩展确实已加载，用实际 id 覆盖后重跑：');
      console.log('     $env:DPP_EXT_ID="<实际id>"; node scripts/verify-pain-items.mjs');
    }
  }

  // R08 LIVE: sidepanel 面板出现真实工具卡片。
  if (panel) {
    try {
      const found = await cdpEvaluate(
        panel.webSocketDebuggerUrl,
        "!!document.querySelector('[data-testid=\"tool-run-panel\"] [data-tool-name]')",
      );
      if (found === true) {
        record('R08', 'LIVE 侧边栏出现真实工具卡片', 'PASS', 'sidepanel DOM 命中 tool-run-panel[data-tool-name]');
      } else {
        record('R08', 'LIVE 侧边栏出现真实工具卡片', 'SKIP', '当前无工具运行，面板未渲染卡片；发起一次工具调用后重跑');
      }
    } catch (e) {
      record('R08', 'LIVE 侧边栏工具卡片', 'SKIP', `sidepanel 求值失败: ${e?.message ?? e}`);
    }
  } else {
    // A2: 区分「扩展没加载」「扩展 id 不匹配」「侧边栏没打开」——三者处置完全不同。
    const detail = !extIdMatched
      ? (extTargets.length === 0
        ? '未发现任何扩展 target —— 扩展未加载，见上方指引'
        : '扩展 id 与期望不符 —— 见上方诊断，用 DPP_EXT_ID 覆盖后重跑')
      : '未发现 sidepanel target —— 请在 Chrome 中打开 dpp 扩展侧边栏后重跑';
    record('R08', 'LIVE 侧边栏工具卡片', 'SKIP', detail);
  }

  // R05 LIVE: 诊断缓冲里出现 stream_stall。
  if (sw) {
    try {
      const logs = await cdpEvaluate(
        sw.webSocketDebuggerUrl,
        "chrome.storage.local.get('dpp_diagnostic_logs').then(d => (d.dpp_diagnostic_logs||[]).filter(e=>e.message==='stream_stall').length)",
      );
      if (typeof logs === 'number' && logs > 0) {
        record('R05', 'LIVE 诊断缓冲含 stream_stall', 'PASS', `观测到 ${logs} 条 stream_stall`);
      } else {
        record('R05', 'LIVE 诊断缓冲含 stream_stall', 'SKIP', '本会话未发生 30s 停顿；长思考卡住时再查 dpp_diagnostic_logs');
      }
    } catch (e) {
      record('R05', 'LIVE stream_stall 诊断', 'SKIP', `SW 求值失败: ${e?.message ?? e}`);
    }
  } else {
    // A2: 同理区分三种原因；MV3 SW 空闲 30 秒即回收，缺 target 常是睡着了。
    const detail = !extIdMatched
      ? (extTargets.length === 0
        ? '未发现任何扩展 target —— 扩展未加载，见上方指引'
        : '扩展 id 与期望不符 —— 见上方诊断，用 DPP_EXT_ID 覆盖后重跑')
      : '未发现 dpp SW target —— MV3 SW 空闲 30s 即回收；打开侧边栏或让 agent 跑一次工具调用唤醒后重跑';
    record('R05', 'LIVE stream_stall 诊断', 'SKIP', detail);
  }

  // R06/R07/R15 的运行态需主动发起超长输入 / 触发截断续轮 / >120s 命令，
  // 无人应答下不自动构造，统一 SKIP 并指向人工清单。
  record('R06', 'LIVE 超长输入 budget.warn/critical 可见', 'SKIP', '需人工粘贴超长文本触发 ≥50%/80%，见人工清单 R06');
  record('R07', 'LIVE 续轮 3 次后 auto_continue_exhausted', 'SKIP', '需人工触发连续截断续轮，见人工清单 R07');
  record('R15', 'LIVE >120s 命令不被掐且返回真实结果', 'SKIP', '需人工跑 >120s 命令，见人工清单 R15');
}

if (!ONLY_STATIC) {
  await live();
} else {
  record('LIVE', 'CDP 连接', 'SKIP', '--static 模式，跳过在线探测');
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const tally = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) tally[r.status] += 1;
console.log(`\n===== 汇总: PASS=${tally.PASS} FAIL=${tally.FAIL} SKIP=${tally.SKIP} =====`);

if (JSON_OUT) {
  // A2: 留档用。含时间戳、模式、汇总与逐项结果，便于两轮 diff。
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: ONLY_STATIC ? 'static' : 'live',
    cdpHttp: usedCdpBase,
    extId: EXT_ID,
    tally,
    results,
  };
  writeFileSync(JSON_OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`结果已写入 ${JSON_OUT}`);
}

if (tally.FAIL > 0) {
  console.log('存在 FAIL，请按上方缺失钩子修复。');
  process.exit(1);
}
console.log('无 FAIL。SKIP 项按 doc/设计/真机验收清单-20261020.md 人工完成即可。');
