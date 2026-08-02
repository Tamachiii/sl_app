import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'sl_app_theme';

// Keep in step with the AppShell surface: light is Tailwind gray-50, dark is
// --color-ink-900. Also duplicated as the pre-JS default in index.html.
const STATUS_BAR_COLOR = { light: '#f9fafb', dark: '#111110' };

/**
 * Repaint the status-bar / Dynamic Island strip to match the theme actually
 * rendered. index.html's `theme-color` entries key off `prefers-color-scheme`,
 * but this theme is a user toggle that is free to disagree with the OS — and
 * an installed iOS web app ignores the `media` attribute entirely. Writing
 * every entry leaves one unambiguous value whichever one the UA reads.
 */
function paintStatusBar(theme) {
  const color = STATUS_BAR_COLOR[theme] ?? STATUS_BAR_COLOR.light;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', color);
  }
}

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    paintStatusBar(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(
    () => ({ theme, toggleTheme, setTheme }),
    [theme, toggleTheme, setTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  // Graceful fallback — lets components render in isolation (tests) without a provider.
  if (!ctx) return { theme: 'light', toggleTheme: () => {}, setTheme: () => {} };
  return ctx;
}
