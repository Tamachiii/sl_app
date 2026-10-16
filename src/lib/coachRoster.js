// Attention chip weights. Higher = more urgent = sorts nearer the top.
// "No active program" is a hard block (the athlete can't train at all), so it
// outranks a review backlog, which outranks a quiet spell.
const WEIGHT = { noProgram: 3, toReview: 2, stale: 1 };

// How long without training before an athlete is worth a look. A missed
// recommended day is no longer a signal — the athlete trains when they can —
// so the question became "have they gone quiet?", and a week and a half of
// silence is the point where that stops being an ordinary rest.
export const STALE_AFTER_DAYS = 10;

/**
 * Count sessions still awaiting the coach's review, grouped by `students.id`:
 * `{ [studentId]: n }`, an athlete with none left out. A confirmation needs
 * review when it is neither reviewed nor archived — the predicate of the
 * Sessions feed's inbox, and of `coach_review_counts()` in the database, which
 * `useReviewCounts` asks first; this is what it counts with when the database
 * has no such function. The Sessions tab's badge is the sum of these counts
 * (hooks/useToReviewCount), so the tab and the cards' "N to review" chips say
 * the same. A plain object, which React Query compares and keeps as it is.
 */
export function reviewCountsByStudent(confirmations) {
  const counts = {};
  for (const c of confirmations || []) {
    if (c.reviewed_at || c.archived_at) continue;
    if (!c.student_id) continue;
    counts[c.student_id] = (counts[c.student_id] || 0) + 1;
  }
  return counts;
}

/**
 * Compose the coach's already-loaded roster data into one attention-first list.
 * Pure + synchronous — the component feeds it `useStudents`, the
 * `useCoachDashboardPrograms` summary map, and the `useReviewCounts` counts
 * (`{ [students.id]: n }`), all of which name the coach.
 *
 * Each entry carries the display fields the card needs plus a `chips` array
 * describing WHY the athlete wants attention. Sorting: athletes with any chip
 * float to the top (ranked by their most-urgent chip), then A–Z by name; calm
 * athletes fall below, A–Z. `summary` only holds students with an ACTIVE
 * program, so key-absence — not `activeWeek == null` — is what marks
 * "no active program" (an active program with no scheduled week is not a gap).
 *
 * `summary` and `reviewCounts` may be null (or undefined): the read has not
 * answered — it is on its way, it failed, it waits for the network. Null is
 * UNKNOWN, never empty. An unknown summary gives no "No program" and no
 * "Quiet" chip, and no program name, position or week strip; unknown counts
 * give no "to review" chip. Read as `{}`, a summary that had
 * not arrived — or that was answered by a 500 — put a red "No program" on
 * every athlete and sorted them all to the top (review items P48, N16).
 */
export function buildRoster({ students, summary, reviewCounts }) {
  const summaryKnown = summary != null;

  const entries = (students || []).map((student) => {
    const fullName = student.profile?.full_name || 'Student';
    const entry = summaryKnown ? summary[student.id] : undefined;
    const hasProgram = !!entry;
    const weekDays = entry?.weekDays || null;
    const reviewCount = reviewCounts?.[student.id] || 0;
    const daysSinceLast = entry?.daysSinceLast ?? null;

    const chips = [];
    if (summaryKnown && !hasProgram) chips.push({ kind: 'noProgram' });
    if (reviewCount > 0) chips.push({ kind: 'toReview', n: reviewCount });
    // An athlete who has never logged anything shows no chip: they may have
    // just been assigned a block, and "quiet for ∞ days" is not a finding.
    if (hasProgram && daysSinceLast != null && daysSinceLast >= STALE_AFTER_DAYS) {
      chips.push({ kind: 'stale', days: daysSinceLast });
    }

    const priority = chips.reduce((max, c) => Math.max(max, WEIGHT[c.kind] || 0), 0);

    return {
      student,
      fullName,
      programName: entry?.programName || null,
      position: entry?.position ?? null,
      totalSessions: entry?.totalSessions ?? null,
      daysSinceLast,
      weekDays,
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
