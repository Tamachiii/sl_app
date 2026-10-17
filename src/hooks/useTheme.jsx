import { createContext, useContext, useEffect, useMemo } from 'react';

const ThemeContext = createContext(null);

// The app is light-only: the Parc design system (design/parc/) has one theme.
// An installed iOS PWA takes its status-bar colour from the manifest's single
// static `theme_color` (see docs/INVARIANTS.md), so one theme is also the only
// one whose strip can match.
//
// The provider keeps its shape so that no consumer has to change: `theme` is
// fixed and `toggleTheme`/`setTheme` are no-ops.
const THEME = 'light';
const STATUS_BAR_COLOR = '#FFFFFF'; // Parc's `surface`, the colour of the bars

export function ThemeProvider({ children }) {
  useEffect(() => {
    // index.html ships no theme class; this only takes away a `dark` that
    // something else would have left on <html>.
    document.documentElement.classList.remove('dark');
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
