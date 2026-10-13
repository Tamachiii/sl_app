import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Is there a page of the app behind this one?
//
// `navigate(-1)` is `history.back()`. On the first entry of the tab — a
// session opened from a push notification, a link pasted in the address bar,
// the installed app started on a deep link — there is nothing to go back to:
// a browser leaves the app, an installed PWA does nothing at all, and the back
// button of the page is dead.
//
// The router numbers the entries it creates: `history.state.idx`, 0 for the
// one the tab started on. That number is the answer, and it stays right where
// the location's key does not — a redirect on arrival (`<Navigate replace>`,
// the return from the login page) replaces the first entry and gives it a new
// key, at idx 0 still.
//
// A router that does not write to `window.history` (MemoryRouter, in tests)
// leaves no number there; its first entry is the one whose key is 'default'.
// So is an entry the router did not create — a hash changed from outside — and
// "no way back" is the safe reading of that one.
function hasPageBehind(location) {
  const idx = typeof window === 'undefined' ? undefined : window.history.state?.idx;
  if (typeof idx === 'number') return idx > 0;
  return location.key !== 'default';
}

/**
 * The handler of a page's back button: one step back when the app has a page
 * to go back to, `fallback` otherwise.
 *
 *   const goBack = useBackOr('/student');
 *   <button onClick={goBack} aria-label={t('common.back')}>…</button>
 *
 * `fallback` is the page's parent in the app (a path or a `To` object). It
 * REPLACES the current entry: the page was the first of the tab, and after
 * "back" the system's own back must leave, not return to it.
 */
export function useBackOr(fallback) {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    if (hasPageBehind(location)) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, location, fallback]);
}
