import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nProvider, useI18n } from './useI18n';

const wrapper = ({ children }) => <I18nProvider>{children}</I18nProvider>;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('lang');
});

describe('useI18n (no provider)', () => {
  it('returns the EN passthrough fallback', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.lang).toBe('en');
    // Unknown key passes through
    expect(result.current.t('non.existent.key')).toBe('non.existent.key');
    // setLang is a no-op stub
    expect(() => result.current.setLang('fr')).not.toThrow();
  });
});

describe('I18nProvider', () => {
  it('persists language changes to localStorage and <html lang>', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLang('fr'));
    expect(result.current.lang).toBe('fr');
    expect(window.localStorage.getItem('sl_app_lang')).toBe('fr');
    expect(document.documentElement.getAttribute('lang')).toBe('fr');
  });

  it('rejects unknown languages silently', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    const before = result.current.lang;
    act(() => result.current.setLang('zz'));
    expect(result.current.lang).toBe(before);
  });

  it('exposes the languages array', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.languages).toEqual(['en', 'fr', 'de']);
  });

  it('t() interpolates {param} placeholders', () => {
    // Use a known key from the dictionaries — student.stats.scopeActiveOption.
    const { result } = renderHook(() => useI18n(), { wrapper });
    const out = result.current.t('student.stats.scopeActiveOption', { name: 'Block A' });
    expect(out).toMatch(/Block A/);
  });

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem('sl_app_lang', 'de');
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.lang).toBe('de');
  });
});
