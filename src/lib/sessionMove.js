import { compareSessions } from './day';

/**
 * Where a dragged session lands — the one piece of the program sheet worth
 * testing without a DOM.
 *
 * The block is rendered as ONE continuous list, so a drag can end in the phase
 * it started in (a reorder) or in another one (a move). Those are different
 * writes against different constraints, and getting the id lists wrong is
 * silent data damage rather than a visible bug, so the decision lives here as a
 * pure function over the week tree.
 *
 * Both paths return the FULL ordered id list of every week they touch, archived
 * rows included: `UNIQUE (week_id, sort_order)` spans the whole week, so a
 * renumbering that omits archived rows collides with them.
 */

export const PHASE_DROP_PREFIX = 'phase:';

export function phaseDropId(weekId) {
  return `${PHASE_DROP_PREFIX}${weekId}`;
}

function activeOf(week) {
  return (week.sessions || []).filter((s) => !s.archived_at).sort(compareSessions);
}

function archivedIdsOf(week) {
  return (week.sessions || [])
    .filter((s) => s.archived_at)
    .sort(compareSessions)
    .map((s) => s.id);
}

function moved(list, from, to) {
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/**
 * @returns {null
 *   | { type: 'reorder', weekId, orderedIds }
 *   | { type: 'move', sessionId, destWeekId, sourceIds, destIds }}
 *   `null` when the drag is a no-op or lands on nothing recognised.
 */
export function planSessionDrag(weeks, activeId, overId) {
  const list = weeks || [];
  if (!activeId || !overId || activeId === overId) return null;

  const source = list.find((w) => activeOf(w).some((s) => s.id === activeId));
  if (!source) return null;

  let dest;
  let destIndex;

  if (typeof overId === 'string' && overId.startsWith(PHASE_DROP_PREFIX)) {
    // Dropped on a divider rather than a row — the only way to reach a phase
    // that has no sessions to aim at.
    dest = list.find((w) => w.id === overId.slice(PHASE_DROP_PREFIX.length));
    if (!dest) return null;
    destIndex = 0;
  } else {
    dest = list.find((w) => activeOf(w).some((s) => s.id === overId));
    if (!dest) return null;
    destIndex = activeOf(dest).findIndex((s) => s.id === overId);
  }

  if (dest.id === source.id) {
    const rows = activeOf(source);
    const from = rows.findIndex((s) => s.id === activeId);
    if (from === -1 || destIndex === -1 || from === destIndex) return null;
    return {
      type: 'reorder',
      weekId: source.id,
      orderedIds: [...moved(rows, from, destIndex).map((s) => s.id), ...archivedIdsOf(source)],
    };
  }

  const destIds = activeOf(dest).map((s) => s.id);
  destIds.splice(destIndex, 0, activeId);

  return {
    type: 'move',
    sessionId: activeId,
    destWeekId: dest.id,
    sourceIds: [
      ...activeOf(source).filter((s) => s.id !== activeId).map((s) => s.id),
      ...archivedIdsOf(source),
    ],
    destIds: [...destIds, ...archivedIdsOf(dest)],
  };
}
