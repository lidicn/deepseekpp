/**
 * 扩展 ID 自动发现（C4′）。
 *
 * 背景：dpp 的 manifest **没有 `key`** ⇒ 未打包扩展的 ID 由**加载路径**派生，
 * 换个加载目录 ID 就变（`scripts/install-bridge.mjs` 里已经躺着三个不同 ID 就是证据）。
 * 三个脚本（`tools/reload-extension.py` / `scripts/install-bridge.mjs` /
 * `scripts/verify-pain-items.mjs`）此前都靠硬编码，路径一变就静默失配。
 *
 * 正解是**从浏览器实况发现**：读 CDP `/json/list`，取扩展 target 的 URL。
 * 不采用"路径 SHA-256 → a–p"推导：实测推不出已知 ID（实际加载路径与设想不同），
 * 猜错比报错更糟。
 *
 * 优先级：显式参数 > 环境变量 `DPP_EXT_ID` > CDP 发现 > 抛错（带修复指引）。
 */

const EXTENSION_URL_PREFIX = 'chrome-extension://';

/** 从 CDP target 列表里挑出扩展 ID（纯函数，便于测试）。 */
export function pickExtensionId(targets) {
  if (!Array.isArray(targets)) return null;

  const idFromUrl = (url) => {
    if (typeof url !== 'string' || !url.startsWith(EXTENSION_URL_PREFIX)) return null;
    const rest = url.slice(EXTENSION_URL_PREFIX.length);
    const id = rest.split('/')[0];
    return /^[a-p]{32}$/.test(id) ? id : null;
  };

  // 优先 service_worker：它一定属于"当前运行中的扩展"，比页面更可靠。
  for (const target of targets) {
    if (target && target.type === 'service_worker') {
      const id = idFromUrl(target.url);
      if (id) return id;
    }
  }
  // 其次任意扩展页（sidepanel / options 等）。
  for (const target of targets) {
    const id = idFromUrl(target && target.url);
    if (id) return id;
  }
  return null;
}

/** 读 CDP `/json/list` 并挑出扩展 ID。浏览器没开调试端口时返回 null。 */
export async function discoverExtensionId(options = {}) {
  const port = options.port ?? 9222;
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://${host}:${port}/json/list`, { signal: controller.signal });
    if (!response?.ok) return null;
    return pickExtensionId(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析出本次要用的扩展 ID；都拿不到就抛错，并在报错里写清怎么补救
 * （比回落到某个硬编码默认值、然后静默操作错的扩展要好）。
 */
export async function resolveExtensionId(options = {}) {
  const explicit = options.explicit?.trim();
  if (explicit) return { id: explicit, source: 'explicit' };

  const fromEnv = (options.env ?? process.env).DPP_EXT_ID?.trim();
  if (fromEnv) return { id: fromEnv, source: 'env:DPP_EXT_ID' };

  const discovered = await discoverExtensionId(options);
  if (discovered) return { id: discovered, source: 'cdp' };

  throw new Error(
    'Cannot determine the dpp extension id.\n'
    + '  - Start the browser with --remote-debugging-port=9222 (the script discovers it via CDP), or\n'
    + '  - Set the DPP_EXT_ID environment variable, or\n'
    + '  - Pass it explicitly (--id, or the first positional argument).\n'
    + '  The manifest has no "key", so an unpacked extension id derives from its load path\n'
    + '  and changes when the directory changes: we refuse to guess.',
  );
}
