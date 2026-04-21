import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LANGUAGES, getMessage, resolveInitialLang } from '../lib/i18n';

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => resolveInitialLang());

  useEffect(() => {
    try {
      localStorage.setItem('sl_app_lang', lang);
    } catch {
      // ignore — persistence is best-effort
    }
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', lang);
    }
  }, [lang]);

  const setLang = useCallback((next) => {
    if (LANGUAGES.includes(next)) setLangState(next);
  }, []);

  const t = useCallback((key, params) => getMessage(lang, key, params), [lang]);

  const value = useMemo(() => ({ lang, setLang, t, languages: LANGUAGES }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  // Fallback: render English, no-op setter. Useful for isolated component tests.
  return {
    lang: 'en',
    setLang: () => {},
    t: (key, params) => getMessage('en', key, params),
    languages: LANGUAGES,
  };
}
