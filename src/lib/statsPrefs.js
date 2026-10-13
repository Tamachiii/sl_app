// Persists the Stats page's program scope + Exercise Progression selection
// across navigation and reloads. Keyed per surface (student vs. each coach
// student) so a coach hopping between students doesn't drag the previous
// student's exercise selection along.
//
// Stale ids are tolerated: `resolveStatsScope` checks a saved `scope` against
// the current programs list, and ExerciseProgressChart's existing fallback
// effect handles a saved exerciseId that no longer matches.

const PREFIX = 'sl_stats_prefs:';

export function statsPrefsKey({ surface, studentId }) {
  if (surface === 'coach') return `${PREFIX}coach:${studentId}`;
  return `${PREFIX}self`;
}

export function readStatsPrefs(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* ignore — private mode, malformed JSON, etc. */ }
  return null;
}

export function writeStatsPref(key, field, value) {
  try {
    const current = readStatsPrefs(key) || {};
    if (value == null || value === '') delete current[field];
    else current[field] = value;
    localStorage.setItem(key, JSON.stringify(current));
  } catch { /* ignore */ }
}

export function exerciseStorageKey(prefsKey) {
  return `${prefsKey}:exerciseId`;
}

/**
 * Which scope a Stats page computes, and whether that is known yet.
 *
 *   const { scope, resolved } = resolveStatsScope({
 *     urlScope,        // the page's URL param, '' when it has none
 *     savedScope,      // readStatsPrefs(key)?.scope, read DURING RENDER
 *     programs,        // the athlete's programs list — undefined until read
 *     listUnavailable, // that list failed or is paused: it is not coming
 *   });
 *
 * A Stats page computes ONE scope per visit. It enables its stats query only
 * once `resolved` is true, so the scope has to be decided from what the first
 * render can see — the URL wins, then what was picked last time — and not by
 * an effect that corrects the URL after a first computation with 'all'.
 *
 *   - 'all' and 'active' are known at once.
 *   - A program id is known once the programs list is there: kept when the
 *     list has it, 'all' when it does not (a block deleted or trashed since).
 *     Until then `resolved` is false and `scope` is the id that was asked for,
 *     so the query the page holds disabled is already the one it will run.
 *   - When the list cannot be had (`listUnavailable`), the page does not wait
 *     for it: it computes 'all', as it does for an id it cannot find.
 */
export function resolveStatsScope({ urlScope, savedScope, programs, listUnavailable = false }) {
  const saved = typeof savedScope === 'string' ? savedScope : '';
  const wanted = urlScope || saved || 'all';
  if (wanted === 'all' || wanted === 'active') return { scope: wanted, resolved: true };
  if (Array.isArray(programs)) {
    return { scope: programs.some((p) => p.id === wanted) ? wanted : 'all', resolved: true };
  }
  if (listUnavailable) return { scope: 'all', resolved: true };
  return { scope: wanted, resolved: false };
}
