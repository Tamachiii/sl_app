import en from './en';
import fr from './fr';
import de from './de';

export const LANGUAGES = ['en', 'fr', 'de'];

export const messages = { en, fr, de };

export function resolveInitialLang() {
  try {
    const stored = localStorage.getItem('sl_app_lang');
    if (stored && LANGUAGES.includes(stored)) return stored;
  } catch {
    // localStorage may be unavailable (SSR, private mode) — fall through
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  const short = (nav || '').slice(0, 2).toLowerCase();
  return LANGUAGES.includes(short) ? short : 'en';
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

export function getMessage(lang, key, params) {
  const parts = key.split('.');
  let node = messages[lang] ?? messages.en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in node) {
      node = node[part];
    } else {
      // Fall back to English
      let fallback = messages.en;
      for (const p of parts) {
        if (fallback && typeof fallback === 'object' && p in fallback) {
          fallback = fallback[p];
        } else {
          return key;
        }
      }
      return typeof fallback === 'string' ? interpolate(fallback, params) : key;
    }
  }
  return typeof node === 'string' ? interpolate(node, params) : key;
}
