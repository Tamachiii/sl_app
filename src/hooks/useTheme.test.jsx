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

  describe('status-bar colour', () => {
    // index.html ships three of these; the media-less one is what an installed
    // iOS web app reads, since it ignores the `media` attribute.
    beforeEach(() => {
      document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
      for (const media of ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)', null]) {
        const m = document.createElement('meta');
        m.setAttribute('name', 'theme-color');
        if (media) m.setAttribute('media', media);
        m.setAttribute('content', '#ffffff');
        document.head.appendChild(m);
      }
    });

    const colors = () => [...document.querySelectorAll('meta[name="theme-color"]')]
      .map((m) => m.getAttribute('content'));

    it('repaints EVERY theme-color entry, so no stale value can be picked', () => {
      window.localStorage.setItem('sl_app_theme', 'dark');
      renderHook(() => useTheme(), { wrapper });
      expect(colors()).toEqual(['#111110', '#111110', '#111110']);
    });

    it('follows the toggle even when it disagrees with the OS preference', () => {
      // OS says dark; the coach has forced the app to light. The strip must
      // follow the app, which is what the media queries alone got wrong.
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
      window.localStorage.setItem('sl_app_theme', 'light');
      const { result } = renderHook(() => useTheme(), { wrapper });
      expect(colors().every((c) => c === '#f9fafb')).toBe(true);

      act(() => result.current.toggleTheme());
      expect(colors().every((c) => c === '#111110')).toBe(true);
    });
  });
});
