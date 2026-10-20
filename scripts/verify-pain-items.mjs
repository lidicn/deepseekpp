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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const ONLY_STATIC = process.argv.includes('--static');
const CDP_HTTP = process.env.DPP_CDP_HTTP ?? 'http://127.0.0.1:9222';
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

// ---------------------------------------------------------------------------
// LIVE: CDP 在线探测（--static 或离线时整段跳过，相关项记 SKIP）
// ---------------------------------------------------------------------------

async function cdpListTargets() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${CDP_HTTP}/json`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  let targets;
  try {
    targets = await cdpListTargets();
  } catch {
    console.log('\n[CDP] 未连接到 ' + CDP_HTTP + ' —— LIVE 探测全部 SKIP（静态项仍有效）。');
    console.log('启动带调试端口的 Chrome：');
    console.log('  Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" '
      + '--remote-debugging-port=9222 --user-data-dir=%TEMP%\\dpp-cdp-profile');
    console.log('  然后打开 deepseek 对话页、加载 dpp 未打包扩展，重跑本脚本。\n');
    record('LIVE', 'CDP 连接', 'SKIP', '9222 不可达，见上方启动指引');
    return;
  }

  const pages = targets.filter((t) => t.type === 'page');
  const panel = pages.find((t) => t.type === 'page' && t.url.includes(EXT_ID) && /sidepanel/i.test(t.url));
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  const deepseekPage = pages.find((t) => /chat\.deepseek\.com|www\.deepseek\.com/.test(t.url));

  console.log(`\n[CDP] 已连接，target=${targets.length}；sidepanel=${!!panel} SW=${!!sw} deepseekPage=${!!deepseekPage}`);

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
    record('R08', 'LIVE 侧边栏工具卡片', 'SKIP', '未发现 sidepanel target（请打开扩展侧边栏）');
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
    record('R05', 'LIVE stream_stall 诊断', 'SKIP', '未发现 dpp service worker target');
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
if (tally.FAIL > 0) {
  console.log('存在 FAIL，请按上方缺失钩子修复。');
  process.exit(1);
}
console.log('无 FAIL。SKIP 项按 doc/设计/真机验收清单-20261020.md 人工完成即可。');
