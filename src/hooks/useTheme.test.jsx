import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './useTheme';

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const m = document.createElement('meta');
  m.setAttribute('name', 'theme-color');
  m.setAttribute('content', '#ffffff');
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
  it('returns a safe dark stub', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(() => result.current.toggleTheme()).not.toThrow();
    expect(() => result.current.setTheme('light')).not.toThrow();
  });
});

// The app is dark-only: an installed iOS PWA colours its status bar from the
// manifest's single static theme_color, so a light theme could never match the
// strip. See docs/INVARIANTS.md.
describe('ThemeProvider (dark-only)', () => {
  it('applies dark and reports dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores a stored light preference left over from the toggle', () => {
    window.localStorage.setItem('sl_app_theme', 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores an OS light preference', () => {
    window.matchMedia = (query) => ({
      matches: false, // prefers-color-scheme: dark → false
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
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('paints every theme-color entry on the dark surface', () => {
    renderHook(() => useTheme(), { wrapper });
    const colors = [...document.querySelectorAll('meta[name="theme-color"]')]
      .map((m) => m.getAttribute('content'));
    expect(colors.every((c) => c === '#111110')).toBe(true);
  });

  it('keeps toggleTheme/setTheme as no-ops so stale callers cannot flip it', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.toggleTheme());
    act(() => result.current.setTheme('light'));
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
