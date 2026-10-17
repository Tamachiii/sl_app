import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './useTheme';

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.add('dark');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const m = document.createElement('meta');
  m.setAttribute('name', 'theme-color');
  m.setAttribute('content', '#111110');
  document.head.appendChild(m);
});

afterEach(() => {
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
  it('returns a safe light stub', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(() => result.current.toggleTheme()).not.toThrow();
    expect(() => result.current.setTheme('dark')).not.toThrow();
  });
});

// The app is light-only: the Parc design system has one theme, and an
// installed iOS PWA colours its status bar from the manifest's single static
// theme_color. See docs/INVARIANTS.md.
describe('ThemeProvider (light-only)', () => {
  it('takes a stray dark class away and reports light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores a stored dark preference left over from the toggle', () => {
    window.localStorage.setItem('sl_app_theme', 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores an OS dark preference', () => {
    window.matchMedia = (query) => ({
      matches: true, // prefers-color-scheme: dark → true
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('paints every theme-color entry on the surface colour', () => {
    renderHook(() => useTheme(), { wrapper });
    const colors = [...document.querySelectorAll('meta[name="theme-color"]')]
      .map((m) => m.getAttribute('content'));
    expect(colors.every((c) => c === '#FFFFFF')).toBe(true);
  });

  it('keeps toggleTheme/setTheme as no-ops so stale callers cannot flip it', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.toggleTheme());
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
