/**
 * S5 守卫：主题层（token 化 / 深浅色 / 离线 / 单一产出点）。
 *
 * 变异（可判红）：
 *   ① 删掉 dark 覆盖块 ⇒ 用例 2 红；
 *   ② 往 CSS 里加一个外部 @import 或 url(...) ⇒ 用例 3（离线不变式）红。
 */
import { describe, expect, it } from 'vitest';
import { buildVisCss, VIS_THEME_TOKENS } from '../core/vis/theme';

const REQUIRED_CLASSES = [
  '.dppvis-column',
  '.dppvis-text--title',
  '.dppvis-text--subtitle',
  '.dppvis-text--body',
  '.dppvis-text--meta',
  '.dppvis-img',
  '.dppvis-ratio-2x3',
  '.dppvis-ratio-16x9',
  '.dppvis-img--placeholder',
  '.dppvis-img__alt',
];

const REQUIRED_TOKENS = [
  '--dppvis-radius',
  '--dppvis-gap',
  '--dppvis-panel',
  '--dppvis-border',
  '--dppvis-text',
  '--dppvis-muted',
  '--dppvis-accent',
  '--dppvis-font',
  '--dppvis-hue',
];

describe('S5 主题层', () => {
  it('★ 渲染器产出的每个类名在 CSS 里都有定义（类名与样式同步演进）', () => {
    const css = buildVisCss();
    for (const cls of REQUIRED_CLASSES) expect(css).toContain(cls);
    for (const token of REQUIRED_TOKENS) expect(css).toContain(token);
  });

  it('★ 深浅色：两套 token 都存在，且 dark 覆盖块独立可取', () => {
    const css = buildVisCss();
    expect(css).toContain('[data-dppvis-theme="dark"]');
    expect(VIS_THEME_TOKENS.light.panel).not.toBe(VIS_THEME_TOKENS.dark.panel);
    expect(css).toContain(VIS_THEME_TOKENS.light.panel);
    expect(css).toContain(VIS_THEME_TOKENS.dark.panel);
  });

  it('★ 离线不变式：CSS 不含任何外部资源引用（@import / url(http…) / 远程字体）', () => {
    const css = buildVisCss();
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/i);
  });

  it('负控：scope 可定制（注入层能限制作用域，避免污染宿主页面）', () => {
    const css = buildVisCss({ scope: '#dpp-vis-slot' });
    expect(css).toContain('#dpp-vis-slot');
    expect(css).toContain('#dpp-vis-slot .dppvis-text--title');
    // 默认 scope 不应残留在定制产出里
    expect(css.startsWith('.dppvis-root')).toBe(false);
  });

  it('负控：占位底色只依赖 --dppvis-hue（不读任何外链），且尊重 reduced-motion', () => {
    const css = buildVisCss();
    expect(css).toContain('hsl(var(--dppvis-hue)');
    expect(css).toContain('prefers-reduced-motion');
  });
});
