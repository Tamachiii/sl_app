// Persists the Stats page's program scope + Exercise Progression selection
// across navigation and reloads. Keyed per surface (student vs. each coach
// student) so a coach hopping between students doesn't drag the previous
// student's exercise selection along.
//
// Stale ids are tolerated: the parent components re-validate `scope` against
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
