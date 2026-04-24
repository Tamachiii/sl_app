import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Single source of truth for "where the coach was last looking under the
// Students tab". Stores the full route path (incl. query string) so the
// restore can drop the coach straight back into WeekView / SessionEditor —
// not just /coach/students/:id.
const KEY = 'sl_last_coach_students_path';
// Skip-write list — we don't want the empty-selector page to become the
// restore target (that would defeat the whole point of persistence).
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

// Pull a studentId out of either `/coach/students/:id...` or
// `/coach/student/:id/...` so CoachHome can validate the saved path against
// the current students list (skip restore when the student was removed).
export function studentIdFromPath(path) {
  if (!path) return null;
  const m = path.match(/^\/coach\/students?\/([^/?#]+)/);
  return m ? m[1] : null;
}
