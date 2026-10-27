import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
// 侧边栏只用这六个命名空间（见 core/i18n/sidepanel-resources.ts 的说明）；
// 走这个模块而**不是** core/i18n/index.ts，避免把 background/content 的字典
// 通过共享 runtime chunk 带进侧边栏初始壳（实测约 72 KB raw / 22 KB gzip）。
import { createSidepanelTranslator } from '../../core/i18n/sidepanel-resources';
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  resolveLocalePreference,
} from '../../core/i18n/runtime';
import type {
  LocalePreference,
  MessageParams,
  SupportedLocale,
} from '../../core/i18n/types';
// 类型导入会被完全擦除（不进产物），所以从聚合模块取 key 类型不会把字典带进初始壳。
import type { LocaleArrayKey, LocaleMessageKey } from '../../core/i18n';
import {
  getLocalePreference,
  saveLocalePreference,
  watchLocalePreference,
} from '../../core/i18n/store';

interface I18nContextValue {
  locale: SupportedLocale;
  preference: LocalePreference;
  fallback: boolean;
  ready: boolean;
  t: (key: LocaleMessageKey, params?: MessageParams) => string;
  ta: (key: LocaleArrayKey) => readonly string[];
  setPreference: (preference: LocalePreference) => Promise<void>;
}

const defaultTranslator = createSidepanelTranslator(DEFAULT_LOCALE);

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  preference: DEFAULT_LOCALE_PREFERENCE,
  fallback: false,
  ready: false,
  t: defaultTranslator.t,
  ta: defaultTranslator.ta,
  async setPreference() {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(DEFAULT_LOCALE_PREFERENCE);
  const [ready, setReady] = useState(false);

  const resolved = useMemo(
    () => resolveLocalePreference(preference),
    [preference],
  );
  const translator = useMemo(
    () => createSidepanelTranslator(resolved.locale),
    [resolved.locale],
  );

  useEffect(() => {
    let cancelled = false;
    getLocalePreference()
      .then((nextPreference) => {
        if (!cancelled) setPreferenceState(nextPreference);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    const unsubscribe = watchLocalePreference((nextPreference) => {
      setPreferenceState(nextPreference);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setPreference = useCallback(async (nextPreference: LocalePreference) => {
    const normalized = await saveLocalePreference(nextPreference);
    setPreferenceState(normalized);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale: resolved.locale,
    preference,
    fallback: resolved.fallback,
    ready,
    t: translator.t,
    ta: translator.ta,
    setPreference,
  }), [preference, ready, resolved.fallback, resolved.locale, setPreference, translator.t, translator.ta]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
