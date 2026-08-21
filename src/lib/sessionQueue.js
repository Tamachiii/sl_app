// The student's training QUEUE.
//
// A block is an ordered list of sessions the student works through at their own
// pace. Position in that list — not the calendar — decides what comes next, and
// the calendar records what happened. That inversion is the whole point: a
// session the student didn't get to on its recommended day is not "missed" and
// does not need to be moved; it is simply still next.
//
// Order is program order: weeks in (program.sort_order, week_number), sessions
// within a week by `compareSessions` (recommended weekday, then sort_order).
// Weeks survive as an optional ordinal grouping — a "phase" the coach may label
// "Deload" or "Peak" — never as a calendar week, which is why nothing here
// derives a date from a week number.

import { compareSessions, parseISODate, performedDate } from './day';
import { daysSince } from './lastPerformance';

/**
 * Order two sessions inside the same week.
 *
 * `compareSessions` ranks by WEEKDAY, which is the coach's reading order and
 * the right answer for the recommended-day hints that are now the norm. But
 * two sessions carrying real `scheduled_date`s in different calendar weeks
 * would sort by weekday alone — putting a session dated the 13th (a Monday)
 * ahead of one dated the 10th (a Friday). When both dates are real, the dates
 * decide; everything else falls through to the weekday order.
 */
function compareQueued(a, b) {
  const da = a?.scheduled_date && parseISODate(a.scheduled_date) ? a.scheduled_date : null;
  const db = b?.scheduled_date && parseISODate(b.scheduled_date) ? b.scheduled_date : null;
  if (da && db && da !== db) return da < db ? -1 : 1;
  return compareSessions(a, b);
}

/**
 * Every session of a program tree in program order, each tagged with its week.
 *
 * Sorts defensively rather than trusting the caller: `useStudentProgramDetails`
 * already returns weeks and sessions ordered, but a pure function that only
 * works on pre-sorted input is a trap for the next caller.
 */
export function flattenSessions(weeks) {
  const ordered = (weeks || []).slice().sort((a, b) => {
    const ap = a?.program?.sort_order ?? 0;
    const bp = b?.program?.sort_order ?? 0;
    if (ap !== bp) return ap - bp;
    return (a?.week_number ?? 0) - (b?.week_number ?? 0);
  });
  const out = [];
  for (const week of ordered) {
    const sessions = (week?.sessions || []).slice().sort(compareQueued);
    for (const session of sessions) out.push({ session, week });
  }
  return out;
}

/**
 * Build the queue plus the activity figures the Home greeting reads.
 *
 * `upcoming` is what the student can start right now, in order — archived
 * sessions (the coach pulled them) and confirmed ones drop out. `position` is
 * the 1-based place of the next session among the non-archived sessions of the
 * block, so the UI can say "Session 7 of 24" without recounting.
 *
 * Activity is measured from `sessions.performed_at` — the day the student
 * actually trained — not from confirmation timestamps, which record when the
 * write reached the server and can be days late after an offline session.
 * Sessions confirmed before that column existed simply don't contribute; the
 * figures degrade quietly rather than lying.
 *
 * `now` is injectable so the whole thing stays pure and testable.
 */
export function buildQueue(weeks, confirmedIds, { now } = {}) {
  const ref = now || new Date();
  const entries = flattenSessions(weeks);
  const confirmed = confirmedIds || new Set();

  const upcoming = [];
  let total = 0;
  let completed = 0;
  let lastPerformedAt = null;
  let doneLast7 = 0;

  for (const entry of entries) {
    const s = entry.session;
    if (!s || s.archived_at) continue;
    total += 1;

    if (confirmed.has(s.id)) {
      completed += 1;
      const performed = performedDate(s);
      if (performed) {
        const iso = s.performed_at;
        if (!lastPerformedAt || iso > lastPerformedAt) lastPerformedAt = iso;
        const days = daysSince(iso, ref);
        if (days != null && days < 7) doneLast7 += 1;
      }
      continue;
    }
    upcoming.push(entry);
  }

  return {
    upcoming,
    total,
    completed,
    // Where the next session sits in the block. Clamped to `total` so a fully
    // finished block reads "24 of 24" rather than "25 of 24".
    position: total === 0 ? 0 : Math.min(completed + 1, total),
    lastPerformedAt,
    daysSinceLast: daysSince(lastPerformedAt, ref),
    doneLast7,
  };
}
