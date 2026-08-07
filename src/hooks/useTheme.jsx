import { createContext, useContext, useEffect, useMemo } from 'react';

const ThemeContext = createContext(null);

// The app is dark-only. An installed iOS PWA takes its status-bar colour from
// the manifest's single static `theme_color` (see docs/INVARIANTS.md), so a
// light theme could never match the strip once the app left Safari — the
// toggle was shipping a guaranteed mismatch for half its users.
//
// This is deliberately the cheap version of "remove the light theme": the
// `.dark` remaps in index.css all stay, and so does this provider's shape.
// Reinstating the toggle means restoring ThemeToggle.jsx and giving `theme`
// its state back — no CSS archaeology.
const THEME = 'dark';
const STATUS_BAR_COLOR = '#111110'; // --color-ink-900, the AppShell surface

export function ThemeProvider({ children }) {
  useEffect(() => {
    // index.html already ships `class="dark"` so the first paint is dark with
    // no light flash; this only guarantees it against a stray removal.
    document.documentElement.classList.add('dark');
    // Safari tabs and Android read `theme-color` (an installed iOS app doesn't
    // — it uses the manifest). Keep every entry on the one surface colour.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', STATUS_BAR_COLOR);
    }
  }, []);

  // `toggleTheme`/`setTheme` stay as no-ops so any consumer still compiles.
  const value = useMemo(
    () => ({ theme: THEME, toggleTheme: () => {}, setTheme: () => {} }),
    []
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
  if (!ctx) return { theme: THEME, toggleTheme: () => {}, setTheme: () => {} };
  return ctx;
}
