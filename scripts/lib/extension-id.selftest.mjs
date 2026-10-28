/**
 * C4′ 自检：扩展 ID 自动发现。
 *
 * 为什么不用 vitest：`.mjs` 放在 `scripts/lib/` 下被 vitest 收集时，transform 阶段会卡在
 * `externalize-deps` 插件（实测挂死 >120s）。而这三个脚本本身就是**用 node 跑的**，
 * 所以用 node 自检更贴近真实运行方式，也能直接进 CI（`npm run verify:ext-id`）。
 *
 * 运行：node scripts/lib/extension-id.selftest.mjs
 */
import { createServer } from 'node:http';
import {
  discoverExtensionId,
  pickExtensionId,
  resolveExtensionId,
} from './extension-id.mjs';

const GOOD = 'jjjhcjjegfplcfncohmfhbdhcalmijnc';
let failed = 0;

function check(name, pass, detail) {
  if (pass) {
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// A. pickExtensionId 优先级与合法性
eq('优先 service_worker', pickExtensionId([
  { type: 'page', url: 'https://example.com/' },
  { type: 'service_worker', url: `chrome-extension://${GOOD}/background.js` },
  { type: 'page', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel.html' },
]), GOOD);

eq('无 SW 时取扩展页', pickExtensionId([
  { type: 'page', url: 'https://example.com/' },
  { type: 'page', url: `chrome-extension://${GOOD}/sidepanel.html` },
]), GOOD);

eq('非扩展 URL 不认', pickExtensionId([{ type: 'service_worker', url: 'https://example.com/bg.js' }]), null);
eq('非法 ID 形态不认', pickExtensionId([{ type: 'page', url: 'chrome-extension://not-valid/sidepanel.html' }]), null);
eq('大写 ID 不认', pickExtensionId([{ type: 'page', url: `chrome-extension://${GOOD.toUpperCase()}/x.html` }]), null);
eq('空输入不认', pickExtensionId([]), null);

// B. discoverExtensionId 真的会读 CDP /json/list（本地假服务）
const server = createServer((req, res) => {
  if (req.url === '/json/list') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { type: 'service_worker', url: `chrome-extension://${GOOD}/background.js` },
      { type: 'page', url: 'https://example.com/' },
    ]));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
try {
  eq('CDP 发现成功', await discoverExtensionId({ port }), GOOD);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// C. CDP 不可达 ⇒ null（交给上层决定），不抛错
eq('CDP 不可达返回 null', await discoverExtensionId({ port: 1, timeoutMs: 400 }), null);

// D. resolveExtensionId 优先级
eq('显式 > 环境变量', await resolveExtensionId({ explicit: 'explicitid', env: { DPP_EXT_ID: 'envid' } }),
  { id: 'explicitid', source: 'explicit' });
eq('环境变量可用', await resolveExtensionId({ env: { DPP_EXT_ID: 'envid' }, port: 1, timeoutMs: 300 }),
  { id: 'envid', source: 'env:DPP_EXT_ID' });

// E. 全无 ⇒ 抛错且报错含补救指引（不许回落到猜的默认值）
let threw = null;
try {
  await resolveExtensionId({ env: {}, port: 1, timeoutMs: 300 });
} catch (error) {
  threw = String(error && error.message);
}
check('全无时抛错并给补救指引', Boolean(threw && /DPP_EXT_ID/.test(threw) && /--remote-debugging-port/.test(threw)), threw ?? 'no throw');

console.log(failed === 0 ? '\nALL PASS' : `\nFAILED ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
