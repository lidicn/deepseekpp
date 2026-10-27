/**
 * 侧边栏专用的 i18n 资源集。
 *
 * 背景（性能，非功能）：`core/i18n/index.ts` 会把**全部 10 个命名空间 × 2 语言**
 * 聚合成一个 `localeResources` 常量。它被 background / content / sidepanel 三个入口共用，
 * 于是 Rollup 把这些字典放进**共享 runtime chunk**，而侧边栏的初始壳又要加载那个 chunk
 * ⇒ 侧边栏白白多背了 `tool/prompt/background/content` 四套字典（实测约 72 KB raw / 22 KB gzip）。
 *
 * sourcemap 实测（sidepanel 入口 chunk 的 sources）证明：侧边栏真正用到的只有
 * `common / manifest / app / locale / sidepanel / pet` 六个 —— 与这里保持一致。
 *
 * ⚠ 维护约束：**侧边栏新增文案时必须落在上面六个命名空间内**。
 * 若加了别的命名空间的键，运行时会回退成 key 字符串（构建和类型都不会报错），
 * `tests/sidepanel-i18n-slice.test.ts` 会拦住这种情况。
 */
import { common as enCommon } from './resources/en/common';
import { manifest as enManifest } from './resources/en/manifest';
import { app as enApp } from './resources/en/app';
import { locale as enLocale } from './resources/en/locale';
import { sidepanel as enSidepanel } from './resources/en/sidepanel';
import { pet as enPet } from './resources/en/pet';
import { common as zhCommon } from './resources/zh-CN/common';
import { manifest as zhManifest } from './resources/zh-CN/manifest';
import { app as zhApp } from './resources/zh-CN/app';
import { locale as zhLocale } from './resources/zh-CN/locale';
import { sidepanel as zhSidepanel } from './resources/zh-CN/sidepanel';
import { pet as zhPet } from './resources/zh-CN/pet';
import { createTranslatorIn } from './runtime';
import type { SupportedLocale } from './types';

/** 侧边栏可用的命名空间（新增命名空间必须同时改这里与下面的聚合） */
export const SIDEPANEL_NAMESPACES = [
  'common',
  'manifest',
  'app',
  'locale',
  'sidepanel',
  'pet',
] as const;

const en = {
  common: enCommon,
  manifest: enManifest,
  app: enApp,
  locale: enLocale,
  sidepanel: enSidepanel,
  pet: enPet,
};

const zhCN = {
  common: zhCommon,
  manifest: zhManifest,
  app: zhApp,
  locale: zhLocale,
  sidepanel: zhSidepanel,
  pet: zhPet,
};

/**
 * 侧边栏专用资源集。
 *
 * 类型上按 `typeof en` 收口（而不是 `LocaleMessages`）—— 这样 `createTranslatorIn`
 * 推导出的 key 类型正好只覆盖上面六个命名空间，**用错命名空间在编译期就会报错**。
 */
/** 把字面量类型放宽成 string（两份语言的字面量不同，但结构必须一致） */
type Widened<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widened<U>[]
    : { [K in keyof T]: Widened<T[K]> };

export type SidepanelResources = Widened<typeof en>;

export const sidepanelLocaleResources: Record<SupportedLocale, SidepanelResources> = {
  'zh-CN': zhCN,
  en,
};

export function createSidepanelTranslator(localeInput: unknown) {
  return createTranslatorIn(sidepanelLocaleResources, localeInput);
}
