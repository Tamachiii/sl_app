import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './useTheme';

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  // Reset matchMedia between tests where overridden.
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  });
});

describe('useTheme (no provider)', () => {
  it('returns a safe stub with theme=light', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    // Stubs do not throw.
    expect(() => result.current.toggleTheme()).not.toThrow();
    expect(() => result.current.setTheme('dark')).not.toThrow();
  });
});

describe('ThemeProvider', () => {
  it('reads theme from localStorage when present', () => {
    window.localStorage.setItem('sl_app_theme', 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to matchMedia(prefers-color-scheme: dark) when no storage', () => {
    window.matchMedia = (query) => ({
      matches: query.includes('dark'),
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
  });

  it('toggleTheme flips and persists', () => {
    window.localStorage.setItem('sl_app_theme', 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
    expect(window.localStorage.getItem('sl_app_theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setTheme writes the supplied value', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark');
  });
});
