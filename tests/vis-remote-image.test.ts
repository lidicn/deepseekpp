/**
 * 远程图片通路（无运行时授权）守卫。
 *
 * 设计前提：host 权限在 manifest 一次性声明 http(s)://*，所以**没有**"申请权限"这回事；
 * 图片加载失败时自动交给后台抓取 → data URL；抓不到才降级渐变。
 *
 * 变异（可判红）：
 *   ① error 回调里去掉 `fetchRemoteImage` 分支 ⇒ 用例 3 红；
 *   ② 抓取失败时不降级 ⇒ 用例 4 红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteImage, hostOf, originPatternOf, type RemoteImagePort } from '../core/vis/remote-image';
import { createVisInjector } from '../core/vis/inject';

afterEach(() => {
  document.body.innerHTML = '';
});

const URL_TMDB = 'https://image.tmdb.org/t/p/w342/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg';
const URL_DOUBAN = 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p480747492.jpg';

function makePort(dataUrl: string | null, throws = false): RemoteImagePort {
  return {
    fetchAsDataUrl: vi.fn(async () => {
      if (throws) throw new Error('boom');
      return dataUrl;
    }),
  };
}

describe('origin / host 归一化', () => {
  it('★ 只认 http(s)，归一成 match pattern（不带端口 —— Chrome 的 pattern 不支持端口）', () => {
    expect(originPatternOf(URL_TMDB)).toBe('https://image.tmdb.org/*');
    expect(originPatternOf('http://a.test/x.png')).toBe('http://a.test/*');
    expect(originPatternOf('https://a.test:8443/x.png')).toBe('https://a.test/*');
  });

  it('★ 其它协议与脏输入一律 null', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://a/x.jpg', '', null, 42]) {
      expect(originPatternOf(bad)).toBeNull();
    }
  });

  it('hostOf 给展示用 hostname', () => {
    expect(hostOf(URL_DOUBAN)).toBe('img9.doubanio.com');
    expect(hostOf('javascript:1')).toBeNull();
  });
});

describe('fetchRemoteImage', () => {
  it('★ 走端口拿 data URL', async () => {
    const port = makePort('data:image/jpeg;base64,AAAA');
    expect(await fetchRemoteImage(URL_TMDB, port)).toBe('data:image/jpeg;base64,AAAA');
    expect(port.fetchAsDataUrl).toHaveBeenCalledWith(URL_TMDB);
  });

  it('负控：非法 URL 不碰端口', async () => {
    const port = makePort('data:x');
    expect(await fetchRemoteImage('javascript:alert(1)', port)).toBeNull();
    expect(port.fetchAsDataUrl).not.toHaveBeenCalled();
  });

  it('负控：端口抛错也返回 null（绝不把异常抛给渲染流程）', async () => {
    expect(await fetchRemoteImage(URL_TMDB, makePort(null, true))).toBeNull();
  });
});

describe('注入层 · 失败自动补图', () => {
  function mount(src: string): ShadowRoot | null {
    const turn = document.createElement('div');
    turn.className = 'ds-markdown';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-vis-json';
    code.textContent = JSON.stringify({
      v: 1,
      root: { type: 'Image', src, alt: '海报', ratio: '2/3' },
    });
    pre.appendChild(code);
    turn.appendChild(pre);
    document.body.appendChild(turn);
    const injector = createVisInjector({
      enabled: true,
      document,
      remoteImagePort: makePort('data:image/jpeg;base64,BBBB'),
    });
    injector.scan();
    const host = document.querySelector('.dppvis-host') as HTMLElement | null;
    return host?.shadowRoot ?? null;
  }

  it('★ 图片失败 ⇒ 自动抓取并换成真图（无需用户点击）', async () => {
    const shadow = mount(URL_DOUBAN);
    const img = shadow?.querySelector('img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toContain('doubanio');

    img?.dispatchEvent(new ErrorEvent('error'));
    await new Promise((r) => setTimeout(r, 30));

    const real = shadow?.querySelector('img') as HTMLImageElement | null;
    expect(real?.getAttribute('src')).toContain('data:image/jpeg;base64,BBBB');
    expect(shadow?.querySelector('.dppvis-img--placeholder')).toBeNull();
  });

  it('★ 抓取失败 ⇒ 降级渐变（不出现破图、不出现按钮）', async () => {
    const turn = document.createElement('div');
    turn.className = 'ds-markdown';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-vis-json';
    code.textContent = JSON.stringify({ v: 1, root: { type: 'Image', src: URL_DOUBAN, alt: '海报' } });
    pre.appendChild(code);
    turn.appendChild(pre);
    document.body.appendChild(turn);

    const injector = createVisInjector({ enabled: true, document, remoteImagePort: makePort(null) });
    injector.scan();
    const shadow = (document.querySelector('.dppvis-host') as HTMLElement).shadowRoot;
    (shadow?.querySelector('img') as HTMLImageElement | null)?.dispatchEvent(new ErrorEvent('error'));
    await new Promise((r) => setTimeout(r, 30));

    expect(shadow?.querySelector('img')).toBeNull();
    const holder = shadow?.querySelector('.dppvis-img--placeholder') as HTMLElement | null;
    expect(holder).not.toBeNull();
    expect(holder?.getAttribute('aria-label')).toBe('海报');
    expect(shadow?.querySelector('.dppvis-img--needpermission')).toBeNull();
    injector.dispose();
  });

  it('负控：没给端口时行为不变（直接渐变）', () => {
    const turn = document.createElement('div');
    turn.className = 'ds-markdown';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-vis-json';
    code.textContent = JSON.stringify({ v: 1, root: { type: 'Image', src: URL_DOUBAN, alt: '海报' } });
    pre.appendChild(code);
    turn.appendChild(pre);
    document.body.appendChild(turn);

    const injector = createVisInjector({ enabled: true, document });
    injector.scan();
    const shadow = (document.querySelector('.dppvis-host') as HTMLElement).shadowRoot;
    (shadow?.querySelector('img') as HTMLImageElement | null)?.dispatchEvent(new ErrorEvent('error'));
    expect(shadow?.querySelector('.dppvis-img--placeholder')).not.toBeNull();
    injector.dispose();
  });
});
