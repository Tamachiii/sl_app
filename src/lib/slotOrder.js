/**
 * Where a dragged exercise lands in the session editor, and what it does to
 * the supersets around it — the decision, without a DOM.
 *
 * The editor draws a superset as the run of ADJACENT slots that share a
 * `superset_group` (`groupSlotsBySuperset`, lib/volume.js), while the drag
 * itself is over the flat list. A drop that only renumbered could leave one
 * group in two places — two boxes with the same group, a member stranded
 * outside its box — and the athlete's session view groups the same way.
 *
 * The rules, decided by where the slot is dropped:
 *   - between two members of one superset: it joins that superset;
 *   - beside a member of its own superset: it stays in it (a move inside the
 *     superset, or to its edge);
 *   - anywhere else: it leaves its superset, if it had one;
 * and then, over the whole list, so that every superset is ONE run of at
 * least two slots:
 *   - a superset left with one slot is no superset: its group is cleared;
 *   - a group found in two runs (data written before these rules) keeps its
 *     id on the first run; each later run takes the id of its first slot,
 *     which is a uuid unique to this session.
 *
 * @param slots    the session's slots in their order on screen
 * @param activeId the slot that was dragged
 * @param overId   the slot it was dropped on
 * @returns {null | { orderedIds: string[], changes: { id, sort_order, superset_group }[] }}
 *   `null` when nothing changes. `changes` holds only the slots whose
 *   `sort_order` (0 to n-1, in the new order) or `superset_group` changes.
 */
export function planSlotDrag(slots, activeId, overId) {
  const list = slots || [];
  if (!activeId || !overId || activeId === overId) return null;
  const from = list.findIndex((s) => s.id === activeId);
  const to = list.findIndex((s) => s.id === overId);
  if (from === -1 || to === -1) return null;

  const ordered = list.map((s) => ({ id: s.id, group: s.superset_group ?? null }));
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  const prev = ordered[to - 1]?.group ?? null;
  const next = ordered[to + 1]?.group ?? null;
  const besideOwnGroup = !!moved.group && (prev === moved.group || next === moved.group);
  if (prev && prev === next) moved.group = prev;
  else if (!besideOwnGroup) moved.group = null;

  normalizeRuns(ordered);

  const before = new Map(list.map((s) => [s.id, s]));
  const changes = [];
  ordered.forEach((slot, index) => {
    const was = before.get(slot.id);
    if (was.sort_order !== index || (was.superset_group ?? null) !== slot.group) {
      changes.push({ id: slot.id, sort_order: index, superset_group: slot.group });
    }
  });
  if (changes.length === 0) return null;
  return { orderedIds: ordered.map((s) => s.id), changes };
}

// Every group one run of two or more, in place.
function normalizeRuns(ordered) {
  const seen = new Set();
  let i = 0;
  while (i < ordered.length) {
    const group = ordered[i].group;
    let end = i + 1;
    while (end < ordered.length && group && ordered[end].group === group) end++;
    if (group) {
      if (end - i < 2) {
        ordered[i].group = null;
      } else if (seen.has(group)) {
        const id = ordered[i].id;
        for (let k = i; k < end; k++) ordered[k].group = id;
        seen.add(id);
      } else {
        seen.add(group);
      }
    }
    i = end;
  }
}
