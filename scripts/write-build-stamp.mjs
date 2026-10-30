import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 写入构建指纹（`public/build-stamp.txt`），供 background SW 轮询。
 *
 * 目的：**扩展自我重载**，不需要用户在 chrome://extensions 点按钮。
 * - 每次 `npm run build:chrome` 由 `prebuild:chrome` 调用本脚本
 * - SW 每 3s 读一次该文件；内容变化 ⇒ `chrome.runtime.reload()`
 * - 生产构建若删掉该文件 ⇒ SW 轮询静默失败，不影响任何行为
 */
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync('public', { recursive: true });
writeFileSync('public/build-stamp.txt', stamp, 'utf8');
console.log(`  build-stamp: ${stamp}`);
