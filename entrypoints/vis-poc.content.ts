/**
 * vis-json PoC 渲染入口（独立 content script）。
 *
 * 为什么单独一个入口而不改 `content.ts`：那是 11.5k 行的共享热路径，
 * PoC 阶段的接线不该把回归面扩到它身上。WXT 会按文件名自动生成 manifest 条目。
 *
 * 默认**关闭**：只有 `localStorage.dpp_vis_poc === '1'` 时才启用，
 * 便于真机验证（在控制台执行 `localStorage.dpp_vis_poc='1'` 后刷新）且不影响任何用户。
 */
import { createVisInjector } from '../core/vis/inject';
import type { RemoteImagePort } from '../core/vis/remote-image';

const POC_FLAG_KEY = 'dpp_vis_poc';
/**
 * 远程图片端口：转给后台抓（content script 直连会被 CORS/防盗链挡住）。
 * host 权限已在 manifest 一次性声明，**没有运行时授权**。
 */
function createChromeRemoteImagePort(): RemoteImagePort {
  return {
    async fetchAsDataUrl(url) {
      try {
        const reply = (await chrome.runtime.sendMessage({ type: 'VIS_IMAGE_FETCH', url })) as
          | { dataUrl?: string | null }
          | undefined;
        return reply?.dataUrl ?? null;
      } catch {
        return null;
      }
    },
  };
}

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_idle',
  main() {
    let enabled = false;
    try {
      enabled = localStorage.getItem(POC_FLAG_KEY) === '1';
    } catch {
      enabled = false;
    }
    if (!enabled) return;

    const remoteImagePort = createChromeRemoteImagePort();

    const injector = createVisInjector({
      enabled: true,
      document,
      remoteImagePort,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    });
    injector.start();
    // 自检标记：区分「content script 没跑」与「注入层没生效」，也便于真机排查
    document.documentElement.dataset.dppVisPoc = 'on';

    // 路由/会话切换后页面会重建节点：额外在 popstate 与可见性变化时补一次扫描。
    window.addEventListener('popstate', () => injector.scan());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') injector.scan();
    });
  },
});
