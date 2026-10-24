import { useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
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

export default function RichMessageContent({ text, onRendered }: RichMessageContentProps) {
  const { t } = useI18n();

  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);

  const components: Components = {
    img: markdownImageComponent(t('sidepanel.markdown.externalImageBlocked')),
  };

  return <ReactMarkdown components={components} urlTransform={(url) => url}>{text}</ReactMarkdown>;
}
