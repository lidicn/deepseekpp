/**
 * 主题层：把 `dppvis-*` 类名映射成 CSS。
 *
 * 设计要点（与仓内既有约定对齐）：
 * 1. **token 化**：颜色/间距/圆角全走 `--dppvis-*` 变量，换主题只改变量、不重渲染；
 * 2. **离线**：不引字体、不引外部图片、不出现 `@import` —— 与 dpp「预览不出网」的口径一致；
 * 3. **深浅色**：`[data-dppvis-theme="dark"]` 覆盖变量；同时尊重 `prefers-reduced-motion`；
 * 4. **唯一产出点**：注入层只调 `buildVisCss()`，不在别处拼样式，避免样式漂移。
 */

export type VisThemeName = 'light' | 'dark';

export interface VisThemeTokens {
  radius: string;
  gap: string;
  surface: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  font: string;
}

export const VIS_THEME_TOKENS: Record<VisThemeName, VisThemeTokens> = {
  light: {
    radius: '12px',
    gap: '12px',
    surface: 'transparent',
    panel: '#ffffff',
    border: 'rgba(0, 0, 0, 0.10)',
    text: 'rgba(0, 0, 0, 0.88)',
    muted: 'rgba(0, 0, 0, 0.55)',
    accent: '#2f6feb',
    accentText: '#ffffff',
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  dark: {
    radius: '12px',
    gap: '12px',
    surface: 'transparent',
    panel: '#161b22',
    border: 'rgba(255, 255, 255, 0.12)',
    text: 'rgba(255, 255, 255, 0.92)',
    muted: 'rgba(255, 255, 255, 0.60)',
    accent: '#4c8dff',
    accentText: '#0b1020',
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
};

function tokenBlock(t: VisThemeTokens): string {
  return [
    `  --dppvis-radius: ${t.radius};`,
    `  --dppvis-gap: ${t.gap};`,
    `  --dppvis-surface: ${t.surface};`,
    `  --dppvis-panel: ${t.panel};`,
    `  --dppvis-border: ${t.border};`,
    `  --dppvis-text: ${t.text};`,
    `  --dppvis-muted: ${t.muted};`,
    `  --dppvis-accent: ${t.accent};`,
    `  --dppvis-accent-text: ${t.accentText};`,
    `  --dppvis-font: ${t.font};`,
    '  --dppvis-hue: 210;',
  ].join('\n');
}

/**
 * 生成完整 CSS（含两套主题 token 与全部组件样式）。
 * `scope` 用于把样式限制在容器内（注入层传 `.dppvis-root` 的宿主选择器）。
 */
export function buildVisCss(options: { scope?: string } = {}): string {
  const scope = options.scope ?? '.dppvis-root';
  return `${scope} {
${tokenBlock(VIS_THEME_TOKENS.light)}
  color: var(--dppvis-text);
  font-family: var(--dppvis-font);
  font-size: 14px;
  line-height: 1.55;
}
${scope}[data-dppvis-theme="dark"] {
${tokenBlock(VIS_THEME_TOKENS.dark)}
}
${scope} .dppvis-column { display: flex; flex-direction: column; gap: var(--dppvis-gap); }
${scope} .dppvis-text { margin: 0; overflow-wrap: anywhere; }
${scope} .dppvis-text--title { font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
${scope} .dppvis-text--subtitle { font-size: 13px; font-weight: 600; color: var(--dppvis-muted); }
${scope} .dppvis-text--body { font-size: 14px; }
${scope} .dppvis-text--meta { font-size: 12px; color: var(--dppvis-muted); }
${scope} .dppvis-img {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: var(--dppvis-radius);
  border: 1px solid var(--dppvis-border);
  background: var(--dppvis-panel);
  object-fit: cover;
}
${scope} .dppvis-ratio-2x3 { aspect-ratio: 2 / 3; }
${scope} .dppvis-ratio-16x9 { aspect-ratio: 16 / 9; }
/* 占位不用图：纯 hsl 变量，天然离线、天然无请求 */
${scope} .dppvis-img--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: linear-gradient(
    145deg,
    hsl(var(--dppvis-hue) 42% 24%),
    hsl(calc(var(--dppvis-hue) + 48) 38% 12%)
  );
}
${scope} .dppvis-img__alt {
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  ${scope} * { transition: none !important; animation: none !important; }
}
`;
}
