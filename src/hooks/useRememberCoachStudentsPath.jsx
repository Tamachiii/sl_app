import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Single source of truth for "where the coach was last looking under the
// Athletes tab". Stores the full route path (incl. query string) so a detour
// through Sessions / Messages / Library comes back to the athlete they were
// working on — or deeper, to that athlete's session editor.
//
// CoachHome is the route element for the athlete page AND the parent of the
// session editor (`s/:sessionId` renders in its Outlet), so a single writer
// call there already covers every Athletes-tab destination.
const KEY = 'sl_last_coach_students_path';
// The roster itself must never become the restore target — that would defeat
// the whole point of persistence.
const SKIP_WRITE_PATHS = new Set(['/coach/students']);
// The path a page of the tab found nothing at (`useForgetCoachStudentsPath`),
// so the writer below does not put it back.
const FORGOTTEN_KEY = 'sl_last_coach_students_path_forgotten';

export function useRememberCoachStudentsPath() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (SKIP_WRITE_PATHS.has(pathname)) return;
    const path = pathname + (search || '');
    try {
      if (localStorage.getItem(FORGOTTEN_KEY) === path) return;
      localStorage.removeItem(FORGOTTEN_KEY);
      localStorage.setItem(KEY, path);
    } catch { /* ignore storage errors (private mode, etc.) */ }
  }, [pathname, search]);
}

/**
 * For a page of the Athletes tab that found nothing at its URL — an athlete
 * who is not on the roster, a session that was deleted: while `forget` is
 * true, the URL is not where the tab comes back to. Without it, the Athletes
 * tab would open that "not found" again each time.
 *
 * A mark is left next to the remembered path because the writer runs AFTER
 * this hook when the two run in the same render: React runs a child's effects
 * before its parent's, and the writer sits in CoachHome, above the editor.
 * The writer skips the marked path, and the mark goes with the next path it
 * writes.
 */
export function useForgetCoachStudentsPath(forget) {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!forget) return;
    try {
      localStorage.setItem(FORGOTTEN_KEY, pathname + (search || ''));
      localStorage.removeItem(KEY);
    } catch { /* ignore */ }
  }, [forget, pathname, search]);
}

export function getLastCoachStudentsPath() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function clearLastCoachStudentsPath() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// Pull a studentId out of `/coach/students/:id…` so CoachHome can validate the
// saved path against the current roster and skip the restore when that athlete
// is gone (rather than bouncing into a dead URL).
export function studentIdFromPath(path) {
  if (!path) return null;
  const m = path.match(/^\/coach\/students\/([^/?#]+)/);
  return m ? m[1] : null;
}
