import { useLayoutEffect } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import { useI18n } from '../i18n';

interface RichMessageContentProps {
  text: string;
  onRendered?: () => void;
}

/**
 * 只放行内联资源（data: / blob:）；其它一律拦。
 *
 * 2026-10-24 PM 复验（B6 返工）：原实现是黑名单式（只判 http(s):// 与 //），
 * 被 `\u0000https://evil.example/p.gif` 绕过 —— WHATWG URL 解析会剥掉前导 C0
 * 控制字符，所以谓词放行、浏览器仍会真的出网（实测
 * `new URL('\u0000https://evil.example/x').host === 'evil.example'`）。而 B4 把
 * react-markdown 的 urlTransform 改成恒等后，已失去它自带的协议净化，判定压力
 * 全在这个谓词上。
 *
 * 改白名单后对编码/控制字符/奇怪 scheme 的变体全部免疫，不需要穷举攻击面；
 * 与 X-66 落地的 `default-src 'none'` + 显式放行是同一哲学。
 */
export function isAllowedInlineImageSrc(src: string | undefined | null): boolean {
  const trimmed = (src ?? '').trim();
  return trimmed.startsWith('data:') || trimmed.startsWith('blob:');
}

/**
 * 旧名别名，语义取反：非内联 = 外链/被拦。保留以兼容外部引用。
 */
export function isExternalImageSrc(src: string | undefined | null): boolean {
  return !isAllowedInlineImageSrc(src);
}

interface ImgProps {
  src?: string;
  alt?: string;
}

/**
 * 渲染单张 markdown 图片。非内联图不渲染真 <img>（避免浏览器真实拉取，
 * 泄露 IP / 时序 / 已读信号），改为纯文本占位：alt + 拦截文案。
 * 不使用 <a> 外跳（那会把「不加载」变成「一点就出网」）。
 */
export function markdownImageComponent(blockedLabel: string) {
  return function MarkdownImage({ src, alt }: ImgProps) {
    if (!isAllowedInlineImageSrc(src)) {
      return (
        <span className="ds-markdown-blocked-image" data-blocked-image>
          {alt ? `${alt}：` : ''}{blockedLabel}
        </span>
      );
    }
    return <img src={src} alt={alt ?? ''} />;
  };
}

/**
 * 审计 #31（2026-10-24 报告 P1）：B4 为了让内联图能过，把 `urlTransform` 改成了
 * **全局恒等** `(url) => url`。这连带关掉了 react-markdown 自带的协议净化，
 * 而 `components` 只覆写了 `img` —— **链接 `<a href>` 走的是默认组件 + 恒等 transform**，
 * 于是 `[点我](javascript:alert(1))` 的 href 会被原样保留。
 * 侧栏是扩展自己的页面，点一下就在扩展上下文里执行脚本。
 *
 * 修法：**只对图片的 `src` 放行内联资源**，其余一律走 `defaultUrlTransform`
 * （它的安全协议白名单是 `https?|ircs?|mailto|xmpp`，其它一律置空）。
 *
 * `key` 是属性名（react-markdown 的 `UrlTransform` 签名第二个参数）：图片是 `src`、
 * 链接是 `href`。**必须按 key 区分** —— 只按前缀判断会把
 * `[x](data:text/html,<script>)` 这类 data: 链接也放行。
 */
export function previewUrlTransform(url: string, key?: string): string {
  if (key === 'src' && isAllowedInlineImageSrc(url)) return url;
  return defaultUrlTransform(url);
}

export default function RichMessageContent({ text, onRendered }: RichMessageContentProps) {
  const { t } = useI18n();

  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);

  const components: Components = {
    img: markdownImageComponent(t('sidepanel.markdown.externalImageBlocked')),
  };

  return <ReactMarkdown components={components} urlTransform={previewUrlTransform}>{text}</ReactMarkdown>;
}
