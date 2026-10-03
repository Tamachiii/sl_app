import en from './en';
import fr from './fr';
import de from './de';
import { mergeFragments } from './mergeFragments';

export const LANGUAGES = ['en', 'fr', 'de'];

// The fragments of every package, ONE GLOB PER LANGUAGE (see
// fragments/README.md). Vite expands a glob at build time, so each pattern
// has to be a literal — and each language has its own so that the French and
// German lines can move, unchanged, into the modules that are loaded on
// demand, taking their fragments with them. parity.test.js checks that the
// three together load every file of the folder.
export const fragmentModules = {
  en: import.meta.glob('./fragments/*.en.js', { eager: true, import: 'default' }),
  fr: import.meta.glob('./fragments/*.fr.js', { eager: true, import: 'default' }),
  de: import.meta.glob('./fragments/*.de.js', { eager: true, import: 'default' }),
};

// What the app reads: each dictionary plus that language's fragments.
export const messages = {
  en: mergeFragments(en, fragmentModules.en),
  fr: mergeFragments(fr, fragmentModules.fr),
  de: mergeFragments(de, fragmentModules.de),
};

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

// The lookup itself, over any set of dictionaries: `lang`, then English, then
// the key. getMessage binds it to the app's; the tests run it on a fixture.
export function lookupMessage(dictionaries, lang, key, params) {
  const parts = key.split('.');
  let node = dictionaries[lang] ?? dictionaries.en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in node) {
      node = node[part];
    } else {
      // Fall back to English
      let fallback = dictionaries.en;
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

export function getMessage(lang, key, params) {
  return lookupMessage(messages, lang, key, params);
}
