// Persists the Stats page's program scope + Exercise Progression selection
// across navigation and reloads. Keyed per surface (student vs. each coach
// student) so a coach hopping between students doesn't drag the previous
// student's exercise selection along.
//
// Stale ids are tolerated: `resolveStatsScope` checks a saved `scope` against
// the current programs list, and ExerciseProgressChart's existing fallback
// effect handles a saved exerciseId that no longer matches.
//
// A saved block carries the block that was active when it was picked
// (`activeBlock`): once another block is active, the saved one is forgotten
// and the page computes 'all' (`resolveStatsScope`, `settleSavedScope`). The
// selector offers each block by its id, the active one included, so a choice
// of "the block I am training" used to stay on that block for good, and the
// athlete's training in the next one never showed.

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

/** The `activeBlock` saved beside a block picked while no block was active. */
export const NO_ACTIVE_BLOCK = 'none';

const isBlockScope = (scope) =>
  typeof scope === 'string' && scope !== '' && scope !== 'all' && scope !== 'active';

// The id of the active block, NO_ACTIVE_BLOCK when there is none, undefined
// when the list is not there to say.
function activeBlockOf(programs) {
  if (!Array.isArray(programs)) return undefined;
  return programs.find((p) => p.is_active)?.id ?? NO_ACTIVE_BLOCK;
}

/**
 * What a page saves when a scope is picked: the scope ('all' is saved as
 * nothing), and for a block the block active at that moment.
 */
export function saveStatsScope(key, scope, programs) {
  writeStatsPref(key, 'scope', scope === 'all' ? null : scope);
  writeStatsPref(key, 'activeBlock', isBlockScope(scope) ? activeBlockOf(programs) : null);
}

/**
 * What a page does with the saved scope once its own scope is known, when the
 * URL names none:
 *   - `reset` (from resolveStatsScope): a new block is active since the saved
 *     one was picked — the saved scope is forgotten;
 *   - a block saved before `activeBlock` existed is given the block active
 *     now, so that the next new block forgets it. Until then it stays, as it
 *     always did: nothing says whether it was picked as the current block or
 *     as a past one.
 */
export function settleSavedScope(key, { reset = false, programs } = {}) {
  if (reset) {
    writeStatsPref(key, 'scope', null);
    writeStatsPref(key, 'activeBlock', null);
    return;
  }
  const prefs = readStatsPrefs(key);
  if (!isBlockScope(prefs?.scope) || typeof prefs.activeBlock === 'string') return;
  if (!Array.isArray(programs) || !programs.some((p) => p.id === prefs.scope)) return;
  writeStatsPref(key, 'activeBlock', activeBlockOf(programs));
}

// A block was saved while another block was active, and a third one is
// active now — not the saved one, which the coach may have switched back on.
function replacedSince(saved, savedActiveBlock, programs) {
  if (typeof savedActiveBlock !== 'string' || savedActiveBlock === '') return false;
  const activeNow = programs.find((p) => p.is_active)?.id;
  return !!activeNow && activeNow !== savedActiveBlock && activeNow !== saved;
}

/**
 * Whether a scope holds the block being trained, so that its weeks run to
 * today: 'all' and 'active' do, a block does while it is the active one. A
 * past block's weeks end where its training ended (WeeklyVolumePanel).
 */
export function scopeReachesToday(scope, programs) {
  if (scope === 'all' || scope === 'active') return true;
  return Array.isArray(programs) && programs.some((p) => p.id === scope && p.is_active);
}

/**
 * Which scope a Stats page computes, and whether that is known yet.
 *
 *   const { scope, resolved, reset } = resolveStatsScope({
 *     urlScope,         // the page's URL param, '' when it has none
 *     savedScope,       // readStatsPrefs(key)?.scope, read DURING RENDER
 *     savedActiveBlock, // readStatsPrefs(key)?.activeBlock, the same way
 *     programs,         // the athlete's programs list — undefined until read
 *     listUnavailable,  // that list failed or is paused: it is not coming
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
 *   - A SAVED program id (the URL names none) is also 'all', with `reset:
 *     true`, when another block is active now than when it was picked — the
 *     page then forgets it (`settleSavedScope`). A block in the URL is what
 *     was asked for and is kept. `reset` is only there when it is true.
 *   - When the list cannot be had (`listUnavailable`), the page does not wait
 *     for it: it computes 'all', as it does for an id it cannot find, and
 *     forgets nothing.
 */
export function resolveStatsScope({
  urlScope,
  savedScope,
  savedActiveBlock,
  programs,
  listUnavailable = false,
}) {
  const saved = typeof savedScope === 'string' ? savedScope : '';
  const wanted = urlScope || saved || 'all';
  if (wanted === 'all' || wanted === 'active') return { scope: wanted, resolved: true };
  if (Array.isArray(programs)) {
    if (!programs.some((p) => p.id === wanted)) return { scope: 'all', resolved: true };
    if (!urlScope && replacedSince(wanted, savedActiveBlock, programs)) {
      return { scope: 'all', resolved: true, reset: true };
    }
    return { scope: wanted, resolved: true };
  }
  if (listUnavailable) return { scope: 'all', resolved: true };
  return { scope: wanted, resolved: false };
}
