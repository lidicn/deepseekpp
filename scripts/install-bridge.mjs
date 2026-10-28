#!/usr/bin/env node
/**
 * DPP Bridge 安装器（2026-10-21）。
 *
 * 背景：桥的宿主脚本、启动器、原生宿主清单此前只存在于
 * `E:\NAS\deepseek-pp\scripts\`（在 git 仓库之外，git root 是 `src/`），
 * 所以每次手改都不会被跟踪，换机或重装即丢。同一天里它已经坑了两次：
 *   1. 清单 allowed_origins 把扩展 ID 打错一个字母（...hbbd... 应为 ...hbd...）
 *      → connectNative 直接 "Access to the specified native messaging host is forbidden"
 *   2. .bat 指向 Doubao sandbox_runtime 里早已不存在的 node.exe
 *      → 宿主启动即退出，扩展进入无限重连
 *
 * 本脚本把仓内的规范源码（scripts/bridge/）部署出去，并生成清单 + 写注册表，
 * 让部署变成可复现的一步，而不是靠手改。
 *
 * 用法：
 *   node scripts/install-bridge.mjs
 *   node scripts/install-bridge.mjs --target "E:\NAS\deepseek-pp\scripts"
 *   node scripts/install-bridge.mjs --id <extensionId> --id <extensionId>
 */

import { resolveExtensionId } from './lib/extension-id.mjs';
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.deepseekpp.bridge';
const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'bridge');

/** 已知的三个扩展实例（同一份源码，不同浏览器加载路径会得到不同 ID）。 */
const DEFAULT_EXTENSION_IDS = [
  'jjjhcjjegfplcfncohmfhbdhcalmijnc', // dist/chrome-mv3
  'mincconkikedpopiponllclhhfkgdjna', // dist/edge-mv3（豆包）
  'cnhenmibopmpbbihdokbdfokhfppjlcm', // extensions/edge
];

/** Chromium 系各浏览器各读自己的注册表键；豆包走 Software\Doubao。 */
const REGISTRY_NAMESPACES = [
  'Software\\Google\\Chrome\\NativeMessagingHosts',
  'Software\\Chromium\\NativeMessagingHosts',
  'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'Software\\Doubao\\NativeMessagingHosts',
];

function parseArgs(argv) {
  const target = { dir: 'E:\\NAS\\deepseek-pp\\scripts', ids: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--target' && argv[i + 1]) {
      target.dir = argv[++i];
    } else if (token === '--id' && argv[i + 1]) {
      target.ids.push(argv[++i]);
    } else if (token === '--help' || token === '-h') {
      console.log('用法: node scripts/install-bridge.mjs [--target <dir>] [--id <extensionId> ...]');
      process.exit(0);
    }
  }
  return target;
}

async function main() {
  const { dir, ids } = parseArgs(process.argv.slice(2));
  const targetDir = resolve(dir);
  // C4′：没显式 --id 时，把 CDP 自动发现到的 ID 放在最前；其余已知实例照旧安装（向后兼容）。
  let discovered = null;
  if (ids.length === 0) {
    try {
      const resolved = await resolveExtensionId({});
      discovered = resolved.id;
      console.log(`[ext-id] 自动发现 ${discovered}（来源: ${resolved.source}）`);
    } catch {
      console.log("[ext-id] 未能自动发现扩展 ID（浏览器未开 9222 或未加载扩展）；将只使用内置已知 ID 列表。");
    }
  }
  const extensionIds = ids.length > 0
    ? ids
    : (discovered
      ? [discovered, ...DEFAULT_EXTENSION_IDS.filter((id) => id !== discovered)]
      : DEFAULT_EXTENSION_IDS);

  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`规范源码目录不存在: ${SOURCE_DIR}`);
  }
  mkdirSync(targetDir, { recursive: true });

  // 1) 部署宿主体与启动器
  for (const file of ['dpp-bridge.mjs', 'dpp-bridge.bat']) {
    const from = join(SOURCE_DIR, file);
    const to = join(targetDir, file);
    copyFileSync(from, to);
    console.log(`Deployed:    ${to}`);
  }

  // 2) 生成原生宿主清单（path 用绝对路径，origins 覆盖全部实例）
  //
  // 重要：原生宿主清单的 path 只能是一个可执行文件，Chrome 不会给它传参数。
  // 所以这里必须指向 .bat 启动器（内部用 %~dp0 找到同目录的 dpp-bridge.mjs），
  // 不能直接填 node.exe —— 那会以「无脚本」方式启动 node 然后立刻退出。
  const hostLauncher = join(targetDir, 'dpp-bridge.bat');
  const manifestPath = join(targetDir, 'dpp-bridge-manifest.json');
  const manifest = {
    name: HOST_NAME,
    description: 'DPP Bridge - HTTP API for debugging',
    path: hostLauncher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Manifest:    ${manifestPath}`);
  console.log(`  launcher:  ${manifest.path}`);
  console.log(`  script:    ${join(targetDir, 'dpp-bridge.mjs')}`);
  for (const origin of manifest.allowed_origins) console.log(`  origin:    ${origin}`);

  // 3) 写注册表（HKCU，无需管理员）
  for (const namespace of REGISTRY_NAMESPACES) {
    const key = `HKCU\\${namespace}\\${HOST_NAME}`;
    try {
      execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
      console.log(`Registry:    ${key}`);
    } catch (error) {
      console.error(`Warning: 写注册表失败 ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('\n完成。重启浏览器后扩展会用新清单连接。');
  console.log('清单指向 .bat 启动器；启动器内部按优先级查找 node（可用 DPP_BRIDGE_NODE 覆盖）。');
}

try {
  await main();
} catch (error) {
  console.error(`\n安装失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
