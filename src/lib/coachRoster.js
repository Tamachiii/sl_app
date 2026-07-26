import { deriveWeekStats } from './day';

// Attention chip weights. Higher = more urgent = sorts nearer the top.
// "No active program" is a hard block (the athlete can't train at all), so it
// outranks a review backlog, which outranks a soft missed day.
const WEIGHT = { noProgram: 3, toReview: 2, missed: 1 };

/**
 * Count sessions still awaiting the coach's review, grouped by `students.id`.
 * A confirmation needs review when it is neither reviewed nor archived — the
 * same predicate the Sessions feed uses, just aggregated per athlete.
 */
function reviewCountsByStudent(confirmations) {
  const counts = new Map();
  for (const c of confirmations || []) {
    if (c.reviewed_at || c.archived_at) continue;
    if (!c.student_id) continue;
    counts.set(c.student_id, (counts.get(c.student_id) || 0) + 1);
  }
  return counts;
}

/**
 * Compose the coach's already-loaded roster data into one attention-first list.
 * Pure + synchronous — the component feeds it `useStudents`, the
 * `useCoachDashboardPrograms` summary map, and `useAllConfirmations`, all of
 * which are coach-wide and RLS-scoped, so no new query is needed.
 *
 * Each entry carries the display fields the card needs plus a `chips` array
 * describing WHY the athlete wants attention. Sorting: athletes with any chip
 * float to the top (ranked by their most-urgent chip), then A–Z by name; calm
 * athletes fall below, A–Z. `summary` only holds students with an ACTIVE
 * program, so key-absence — not `activeWeek == null` — is what marks
 * "no active program" (an active program with no scheduled week is not a gap).
 */
export function buildRoster({ students, summary, confirmations, todayDN }) {
  const reviewCounts = reviewCountsByStudent(confirmations);
  const summaryMap = summary || {};

  const entries = (students || []).map((student) => {
    const fullName = student.profile?.full_name || 'Student';
    const entry = summaryMap[student.id];
    const hasProgram = !!entry;
    const weekDays = entry?.weekDays || null;
    const stats = weekDays ? deriveWeekStats(weekDays, todayDN) : null;
    const reviewCount = reviewCounts.get(student.id) || 0;

    const chips = [];
    if (!hasProgram) chips.push({ kind: 'noProgram' });
    if (reviewCount > 0) chips.push({ kind: 'toReview', n: reviewCount });
    if (stats && stats.missed > 0) chips.push({ kind: 'missed', day: stats.firstMissedDay });

    const priority = chips.reduce((max, c) => Math.max(max, WEIGHT[c.kind] || 0), 0);

    return {
      student,
      fullName,
      programName: entry?.programName || null,
      activeWeek: entry?.activeWeek || null,
      weekDays,
      stats,
      chips,
      hasAttention: chips.length > 0,
      priority,
    };
  });

  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.fullName.localeCompare(b.fullName);
  });

  return entries;
}
