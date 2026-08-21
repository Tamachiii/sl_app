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

export function useRememberCoachStudentsPath() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (SKIP_WRITE_PATHS.has(pathname)) return;
    try {
      localStorage.setItem(KEY, pathname + (search || ''));
    } catch { /* ignore storage errors (private mode, etc.) */ }
  }, [pathname, search]);
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
