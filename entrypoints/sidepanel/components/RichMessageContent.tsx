import { useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { useI18n } from '../i18n';

interface RichMessageContentProps {
  text: string;
  onRendered?: () => void;
}

/**
 * 判断图片 src 是否为「外链会出网」地址：http(s):// 与协议相对 //。
 * data: / blob: 等内联图放行。
 */
export function isExternalImageSrc(src: string | undefined | null): boolean {
  if (!src) return false;
  const trimmed = src.trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return false;
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
}

interface ImgProps {
  src?: string;
  alt?: string;
}

/**
 * 渲染单张 markdown 图片。外链图不渲染真 <img>（避免浏览器真实拉取，
 * 泄露 IP / 时序 / 已读信号），改为纯文本占位：alt + 拦截文案。
 * 不使用 <a> 外跳（那会把「不加载」变成「一点就出网」）。
 */
export function markdownImageComponent(blockedLabel: string) {
  return function MarkdownImage({ src, alt }: ImgProps) {
    if (isExternalImageSrc(src)) {
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
