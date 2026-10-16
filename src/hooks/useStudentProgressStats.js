import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { myStudentIdQueryOptions } from './useStudents';
import { computeSessionVolume } from '../lib/volume';
import { addDays, isoDate, parseISODate, performedOnFromLogs, startOfWeekMonday } from '../lib/day';
import { fetchAllRows } from '../lib/supabasePaging';

// The local calendar day of an INSTANT (`confirmed_at`, `logged_at`), or null.
function localDay(stamp) {
  if (!stamp) return null;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? null : isoDate(d);
}

// The calendar day a DATE-valued column holds, or null: `performed_on`, and
// `sessions.performed_at`, which stores that date as midnight UTC. Its date
// part is the day in every zone; `localDay` would put it on the day before
// west of Greenwich.
function calendarDay(value) {
  const d = parseISODate(value);
  return d ? isoDate(d) : null;
}

// The day of the earliest done set that carries a time, or null. Sets ticked
// before `logged_at` existed have none, and `performedOnFromLogs` answers
// "today" for a list without one — a date nobody trained on.
function dayOfDoneSets(doneSets) {
  const stamped = (doneSets || []).filter(
    (l) => l?.logged_at && !Number.isNaN(new Date(l.logged_at).getTime()),
  );
  return stamped.length > 0 ? performedOnFromLogs(stamped) : null;
}

/**
 * The day a session was trained on, or null when nothing says it was.
 *
 * From the most to the least truthful:
 *   1. the confirmation's `performed_on` — the day trained, as the athlete's
 *      device dated it from the sets (`performedOnFromLogs`).
 *   2. `sessions.performed_at` — the mirror `sync_session_performed_at` keeps
 *      of it (and the only date when the confirmation is not in the list),
 *      read as the CALENDAR DATE it stores: `performed_on::timestamptz` is
 *      midnight UTC, which `new Date()` puts on the evening before west of
 *      Greenwich — a Monday session in last week's bucket.
 *   3. the earliest done set's `logged_at` (`performedOnFromLogs`, the rule
 *      the confirmation itself is dated by). This is what dates a session
 *      trained and not confirmed: its sets already count in the totals, so
 *      it goes in the week, the progression and the calendar where they
 *      were lifted, instead of being backlog.
 *   4. the confirmation's `confirmed_at` — the REPLAY moment of an offline
 *      confirm: a fallback, never the primary, and after the sets as in the
 *      backfill of 2026_08_21.
 *   5. `scheduled_date`, for a LEGACY row only: archived AND reviewed. That is
 *      the shape of a session the coach reviewed before confirmations existed,
 *      and the plan date is all it has. A session archived without a review is
 *      the coach's clean-up gesture, and its plan date says nothing about
 *      training.
 *
 * `doneSets` are the session's done set_logs (with `logged_at`). The first
 * two are dates and are read as dates; `logged_at` and `confirmed_at` are
 * instants, read in the device's zone, where the athlete trained.
 */
export function trainedOn(session, { confirmation = null, doneSets = [] } = {}) {
  return (
    calendarDay(confirmation?.performed_on) ||
    calendarDay(session.performed_at) ||
    dayOfDoneSets(doneSets) ||
    localDay(confirmation?.confirmed_at) ||
    (session.archived_at && session.reviewed_at && session.scheduled_date
      ? session.scheduled_date.slice(0, 10)
      : null)
  );
}

/**
 * The one definition of a PERFORMED session, behind every figure of the page:
 * confirmed, or archived with a training date or at least one done set.
 *
 * Archiving is no proof of training. It once followed a review; today it is
 * also how a coach clears a session nobody will train, and a block copied by
 * `duplicate_week` / `duplicate_program` can arrive with archived sessions. An
 * archived session that was never trained is neither done nor to do: it leaves
 * every figure — numerator, denominator, prescribed sets, weekly buckets,
 * progression points and calendar — as `buildQueue` already leaves it out of
 * the athlete's list.
 *
 * `day` is what `trainedOn` answered; `doneSets` counts the done sets of the
 * session, student-added ones included.
 */
export function isPerformed(session, { confirmed = false, day = null, doneSets = 0 } = {}) {
  if (confirmed) return true;
  return !!session.archived_at && (!!day || doneSets > 0);
}

/**
 * Aggregates everything the Student Stats page needs in a single fetch:
 *   - weeks[] with sessions + slots + exercise metadata (for volume maths)
 *   - confirmedSessionIds (Set)
 *   - the DONE set_logs, by slot (done sets, avg RPE, performed volume and tonnage)
 *
 * Stats are scoped via the `scope` parameter:
 *   - 'all'      → every program the student has ever been enrolled in (default)
 *   - 'active'   → only the currently-active program (legacy block-local view)
 *   - <programId> → a single specific program (active or past)
 *
 * Everything time-based is bucketed by the REAL CALENDAR WEEK the student
 * trained in (Mon–Sun of the day `trainedOn` gives), not by the ordinal
 * training week the session was authored under. A block stretched over ten
 * days used to land in a bucket that corresponded to no actual seven-day span;
 * now the chart shows the weeks the student lived. A session trained and not
 * confirmed is dated by its done sets, so it is in the same weeks as the sets
 * it adds to the totals. Work that hasn't been done yet has no date, so it
 * never enters a time bucket — it is counted as backlog.
 *
 * Every figure goes by ONE definition of a performed session (`isPerformed`
 * above): confirmed, or archived with a training date or a done set. An
 * archived session that was never trained is in none of them.
 *
 * Returns derived stats:
 *   - totalSessionsConfirmed (performed), totalSessions (open + archived performed)
 *   - totalSetsDone (prescribed sets done), totalSets (prescribed), totalExtraSetsDone (sets the athlete added, done)
 *   - weeksActive       (calendar weeks in which at least one session was trained)
 *   - backlogSessions   (open sessions with no training date yet)
 *   - avgRpe            (across done sets with rpe logged, added ones included)
 *   - recentConfirmations[] (last 5, newest first)
 *   - weeklyVolume[]    [{ bucket_start, bucket_end, pull, push, *_planned, sets_done, extra_sets_done, sets_prescribed, sessions_confirmed (performed) }]
 *   - sessionCalendar[] [{ session_id, title, date, completed }] — trained sessions on their REAL date, open ones on their recommended date; `completed` is `isPerformed`
 *
 * Pass a `studentId` (students.id row id) to stat any student — used by the
 * coach Students view. Omit it to stat the signed-in user (student flow).
 *
 * `enabled: false` holds the read back. A page passes it while it does not
 * know its scope yet (`resolveStatsScope` in lib/statsPrefs): every scope is a
 * cache entry of its own and a full read, so a page that started with the
 * default and switched a moment later would compute 'all' for nothing.
 *
 * Changing the scope keeps the figures that were on screen until the new ones
 * arrive: `data` is then the PREVIOUS scope's and `isPlaceholderData` is true
 * (`isLoading` stays false). Only between scopes of the same athlete — see
 * `placeholderData` below.
 */
export function useStudentProgressStats(studentId, scope = 'all', { enabled = true } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Whose stats these are: the athlete's row id in the coach flow, the
  // signed-in user in the athlete's.
  const owner = studentId ?? user?.id;

  return useQuery({
    queryKey: ['student-progress-stats', owner, scope],
    queryFn: async () => {
      // 1. Resolve the student row. Coach view passes studentId directly;
      //    student view takes it from the cache entry the whole page shares
      //    (see `myStudentIdQueryOptions`): the Stats page asks for this id
      //    three times, and sends one request for it.
      const resolvedStudentId =
        studentId || (await queryClient.ensureQueryData(myStudentIdQueryOptions(user.id)));

      // 2. Fetch program(s) → weeks → sessions → slots → exercise meta.
      //    The scope parameter swaps the program filter:
      //      - specific id  → single program by id (RLS enforces ownership)
      //      - 'active'     → only the active block (block-local stats)
      //      - 'all'        → every program for this student but a draft
      //    A draft the athlete is writing is no block they train: its sessions
      //    and sets would lower the completion of "All programs" for work no
      //    one asked of them yet. A draft cannot be active, and one picked by
      //    its id is still shown.
      let q = supabase
        .from('programs')
        .select(`
          id, name, sort_order, is_active, status,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, scheduled_date, archived_at, reviewed_at, performed_at,
              exercise_slots(
                id, sets, reps, duration_seconds, weight_kg,
                exercise:exercise_library(id, name, type, difficulty, volume_weight),
                set_logs(set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
              )
            )
          )
        `)
        .eq('student_id', resolvedStudentId)
        // Trashed programs sit out of stats until restored.
        .is('deleted_at', null);

      if (scope === 'all') {
        q = q.neq('status', 'draft');
      } else if (scope === 'active') {
        q = q.eq('is_active', true);
      } else {
        // Treat any other value as a specific program id.
        q = q.eq('id', scope);
      }
      q = q.order('sort_order', { ascending: true });

      // Apply the SAME student + scope + not-trashed filter to a query that
      // reaches `programs` through an embed at `prefix` (e.g.
      // 'sessions.weeks.programs'). Lets the confirmations / set_logs fetches
      // below filter through the join instead of an unbounded .in(id-list),
      // which grows with history and eventually overflows the request URL.
      const applyProgramScope = (query, prefix) => {
        let out = query
          .eq(`${prefix}.student_id`, resolvedStudentId)
          .is(`${prefix}.deleted_at`, null);
        if (scope === 'all') out = out.neq(`${prefix}.status`, 'draft');
        else if (scope === 'active') out = out.eq(`${prefix}.is_active`, true);
        else out = out.eq(`${prefix}.id`, scope);
        return out;
      };

      const { data: programs, error: pErr } = await q;
      if (pErr) throw pErr;

      // Flatten weeks / sessions / slots, preserving program order so weeks
      // from older blocks come before weeks from newer blocks (matters when
      // scope === 'all' — the chart's "recent N" then naturally surfaces the
      // most recent block's tail).
      const weeks = [];
      const allSessions = [];
      const allSlotIds = [];
      // slot id → session id: the flat set_logs list is keyed by slot, and
      // whether a session was trained is a question about the session.
      const sessionBySlot = new Map();

      for (const prog of programs || []) {
        // The filter above already leaves drafts out; a row that says it is
        // one is not counted either way.
        if (scope === 'all' && prog.status === 'draft') continue;
        const sortedWeeks = (prog.weeks || [])
          .slice()
          .sort((a, b) => a.week_number - b.week_number);
        for (const w of sortedWeeks) {
          // Archived sessions are read too: one that was trained keeps every
          // figure it earned when the coach archives it. One that was never
          // trained is left out below (`isPerformed`).
          const allWeekSessions = w.sessions || [];

          weeks.push({
            ...w,
            sessions: allWeekSessions,
            volumeSessions: allWeekSessions,
            program_id: prog.id,
            program_name: prog.name,
            program_sort_order: prog.sort_order,
            program_is_active: !!prog.is_active,
          });

          for (const s of allWeekSessions) {
            allSessions.push(s);
            for (const slot of s.exercise_slots || []) {
              allSlotIds.push(slot.id);
              sessionBySlot.set(slot.id, s.id);
            }
          }
        }
      }
      // Stable order: program sort_order, then week_number within each program.
      weeks.sort((a, b) => {
        if (a.program_sort_order !== b.program_sort_order) {
          return a.program_sort_order - b.program_sort_order;
        }
        return a.week_number - b.week_number;
      });

      // 3. Fetch confirmations + set_logs for this student, filtered THROUGH
      //    the program join (same scope as the tree above) rather than an
      //    .in() over every session/slot id in the tree.
      //
      //    All three reads below are flat lists that grow with the athlete's
      //    history, and PostgREST answers one request with 1000 rows at most
      //    without saying it cut. PERFORMED comes from these lists while
      //    PLANNED comes from the tree, so a cut here reads as an athlete who
      //    stopped training. Each one is therefore read to its end, a page at
      //    a time (lib/supabasePaging) — which also means the rows arrive in
      //    id order, i.e. in no meaningful order.
      //
      //    The three do not depend on each other — each one filters through
      //    the program join, none needs the rows of another — so they go out
      //    TOGETHER and the page waits for the slowest instead of the sum.
      const hasSessions = allSessions.length > 0;
      const hasSlots = allSlotIds.length > 0;

      const [confirmations, setLogs, devRows] = await Promise.all([
        hasSessions
          ? fetchAllRows(() =>
              applyProgramScope(
                supabase
                  .from('session_confirmations')
                  .select(
                    'id, session_id, confirmed_at, performed_on, notes, sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at, status)))'
                  ),
                'sessions.weeks.programs'
              )
            )
          : [],
        // DONE sets only. Every figure derived from this list counts done
        // sets and nothing else (a failed, skipped or still-pending row
        // contributes zero to volume, tonnage, adherence and RPE alike), and
        // the prescribed side — which does need every row — is read from the
        // tree above. The not-done rows were the bulk of the download and
        // none of the result.
        hasSlots
          ? fetchAllRows(() =>
              applyProgramScope(
                supabase
                  .from('set_logs')
                  .select(
                    'id, exercise_slot_id, set_number, done, failed, skipped, is_student_added, rpe, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg, exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at, status))))'
                  )
                  .eq('done', true),
                'exercise_slots.sessions.weeks.programs'
              )
            )
          : [],
        // 3b. Swap deviations for the in-scope slots, with the substitute
        //     exercise's metadata. Lets PERFORMED volume/tonnage follow an
        //     exercise SWAP to what the student actually did, instead of
        //     crediting the coach's original prescription. slot_deviations
        //     has a single FK to exercise_library (substitute_exercise_id), so
        //     the `substitute:exercise_library(...)` embed is unambiguous.
        hasSlots
          ? fetchAllRows(() =>
              applyProgramScope(
                supabase
                  .from('slot_deviations')
                  .select(
                    'id, exercise_slot_id, kind, substitute:exercise_library(id, name, type, difficulty, volume_weight), exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at, status))))'
                  )
                  .eq('kind', 'swap'),
                'exercise_slots.sessions.weeks.programs'
              )
            )
          : [],
      ]);

      // Newest first: `recentConfirmations` below is the head of this list.
      const confirmedStamp = (c) => {
        const t = new Date(c.confirmed_at).getTime();
        return Number.isNaN(t) ? 0 : t;
      };
      confirmations.sort((a, b) => confirmedStamp(b) - confirmedStamp(a));
      const confirmedIds = new Set(confirmations.map((c) => c.session_id));

      // slotId → substitute exercise meta ({id, name, type, difficulty,
      // volume_weight}). Only 'swap' rows carry a substitute; a skipped
      // exercise has no done set_logs, hence 0 performed.
      const swapBySlot = new Map();
      for (const d of devRows) {
        if (d.kind === 'swap' && d.substitute) swapBySlot.set(d.exercise_slot_id, d.substitute);
      }

      // Performance index: every DONE set_log's actuals keyed by slot, so the
      // weekly-volume and per-exercise charts can reflect PERFORMED work
      // (what the student actually did — actuals override targets; skipped
      // and undone sets are not in the list, so they count 0) instead of the
      // coach's prescription alone. This is what makes the off-plan actuals +
      // deviations features visible in the motivation loop.
      const perfBySlot = new Map();
      for (const l of setLogs) {
        if (!perfBySlot.has(l.exercise_slot_id)) perfBySlot.set(l.exercise_slot_id, []);
        perfBySlot.get(l.exercise_slot_id).push(l);
      }
      // Reps a done set actually contributed (logged actual overrides the
      // prescribed target); non-done / skipped sets contribute nothing.
      // On a swap we KEEP the target_reps fallback: the student performed the
      // slot's prescribed rep scheme, just a different movement, so it's a fair
      // VOLUME estimate. (The performance-reporting hooks — useStudentRecords /
      // useLastPerformance — intentionally differ: a PR / "last time" is a
      // measured fact, so they require a logged actual on a swap.)
      // The SLOT says what a set counts: an exercise held for a time
      // (`duration_seconds`, the database allows reps or a duration and never
      // both) has no reps, so a number typed in its actual reps — or an extra
      // set added to it — puts nothing into pull/push volume or tonnage. Its
      // done sets still count as sets done.
      const performedReps = (l, slot) => {
        if (slot?.duration_seconds != null) return 0;
        return l.done ? (l.actual_reps ?? l.target_reps ?? 0) : 0;
      };
      // NOTE: performed LOAD is computed inline in the per-exercise tonnage loop
      // (not a shared helper) because a SWAPPED slot must not fall back to the
      // pinned target_weight_kg — that's the coach's ORIGINAL exercise's load.

      // ─── Derived aggregates ───────────────────────────────────────────────

      // ─── When each session was trained, and whether it was ───────────────
      // `trainedOn` is the one date every time-based aggregate below keys off;
      // `isPerformed` the one answer to "was it done" (both above, at module
      // level). A session with no date has no place on a timeline: an open
      // one is counted as backlog rather than parked on an invented day.
      const confBySession = new Map();
      for (const c of confirmations) confBySession.set(c.session_id, c);

      // Done sets per session, student-added ones included: they date a
      // session that was trained and not confirmed, and one of them is enough
      // to say an archived session was trained.
      const doneSetsBySession = new Map();
      for (const l of setLogs) {
        if (!l.done) continue;
        const sessionId = sessionBySlot.get(l.exercise_slot_id);
        if (!sessionId) continue;
        if (!doneSetsBySession.has(sessionId)) doneSetsBySession.set(sessionId, []);
        doneSetsBySession.get(sessionId).push(l);
      }

      const performedOnBySession = new Map();
      const performedIds = new Set();
      for (const s of allSessions) {
        const doneSets = doneSetsBySession.get(s.id) || [];
        const day = trainedOn(s, { confirmation: confBySession.get(s.id), doneSets });
        const performed = isPerformed(s, {
          confirmed: confirmedIds.has(s.id),
          day,
          doneSets: doneSets.length,
        });
        if (performed) performedIds.add(s.id);
        // An archived session that was not performed has no day by
        // construction (a day makes it performed): nothing time-based can
        // pick it up.
        if (day) performedOnBySession.set(s.id, day);
      }

      // Every figure counts these: the open sessions (done or still to do)
      // and the archived ones that were trained. An archived session never
      // trained is in no numerator and no denominator.
      const countedSessions = allSessions.filter((s) => !s.archived_at || performedIds.has(s.id));

      // Monday of the real calendar week a session was trained in.
      const bucketOf = (sessionId) => {
        const on = performedOnBySession.get(sessionId);
        if (!on) return null;
        const d = parseISODate(on);
        return d ? isoDate(startOfWeekMonday(d)) : null;
      };

      const totalSessions = countedSessions.length;
      const totalSessionsConfirmed = countedSessions.filter((s) => performedIds.has(s.id)).length;

      // Sets done go by the rule of a week's `sets_done`: the PRESCRIBED sets
      // done, out of the prescribed sets of `totalSets`. A set the athlete
      // added is real work — it is in the volume and the tonnage — but no part
      // of the prescription: counted with it, the card read "5 done, of 3
      // prescribed" beside a week that said 3/3. It is reported apart, in
      // `totalExtraSetsDone`. Only sets of the tree count: a row the scope
      // would not have read (a draft's) adds nothing.
      let totalSets = 0;
      let totalSetsDone = 0;
      let totalExtraSetsDone = 0;
      const rpeSamples = [];
      for (const s of countedSessions) {
        for (const slot of s.exercise_slots || []) {
          totalSets += slot.sets || 0;
          for (const l of perfBySlot.get(slot.id) || []) {
            if (!l.done) continue;
            if (l.is_student_added) totalExtraSetsDone += 1;
            else totalSetsDone += 1;
            if (l.rpe != null) rpeSamples.push(l.rpe);
          }
        }
      }

      const avgRpe = rpeSamples.length
        ? rpeSamples.reduce((a, b) => a + b, 0) / rpeSamples.length
        : null;

      // ─── Volume per REAL calendar week ───────────────────────────────────
      // One bucket per Mon–Sun span the student actually trained in. A
      // session's PLANNED volume travels with it into the bucket where it was
      // performed, so planned and performed are always compared over the same
      // days; work still to do has no date and lands in `backlogSessions`
      // instead of dragging down a week it was never attempted in.
      const bucketMap = new Map();
      const bucketFor = (key) => {
        let acc = bucketMap.get(key);
        if (!acc) {
          acc = {
            bucket_start: key,
            bucket_end: isoDate(addDays(parseISODate(key), 6)),
            pull: 0,
            push: 0,
            pull_planned: 0,
            push_planned: 0,
            sets_done: 0,
            extra_sets_done: 0,
            sets_prescribed: 0,
            sessions_confirmed: 0,
          };
          bucketMap.set(key, acc);
        }
        return acc;
      };

      let backlogSessions = 0;
      for (const s of countedSessions) {
        const key = bucketOf(s.id);
        if (!key) {
          if (!s.archived_at) backlogSessions += 1;
          continue;
        }
        const acc = bucketFor(key);
        // A session trained and not confirmed brings its sets and its volume
        // to the week it was lifted in, and is not counted as done.
        if (performedIds.has(s.id)) acc.sessions_confirmed += 1;

        const v = computeSessionVolume(s.exercise_slots || []);
        acc.pull_planned += v.pull;
        acc.push_planned += v.push;

        for (const slot of s.exercise_slots || []) {
          const perf = perfBySlot.get(slot.id) || [];
          acc.sets_prescribed += slot.sets || 0;
          // Adherence measures the PRESCRIBED work done, so student-added
          // extra sets don't push it over 100% (they're bonus, and
          // sets_prescribed never counts them). They still count toward
          // performed volume/tonnage below — that's real work.
          acc.sets_done += perf.filter((l) => l.done && !l.is_student_added).length;
          acc.extra_sets_done += perf.filter((l) => l.done && l.is_student_added).length;
          // Performed volume follows an exercise SWAP: credit the
          // substitute's type/difficulty/volume_weight, since that's the work
          // the student did. Planned (computeSessionVolume above) stays on
          // the coach's original exercise.
          const perfEx = swapBySlot.get(slot.id) || slot.exercise;
          if (!perfEx || !perfEx.type) continue;
          // Performed training volume mirrors computeSessionVolume's
          // difficulty × reps × volume_weight, but sums ACTUAL reps of
          // done sets instead of prescribed reps.
          let doneReps = 0;
          for (const l of perf) doneReps += performedReps(l, slot);
          if (doneReps <= 0) continue;
          const vol = perfEx.difficulty * doneReps * Number(perfEx.volume_weight);
          if (perfEx.type === 'pull') acc.pull += vol;
          else if (perfEx.type === 'push') acc.push += vol;
        }
      }

      const weeklyVolume = Array.from(bucketMap.values()).sort((a, b) =>
        a.bucket_start < b.bucket_start ? -1 : a.bucket_start > b.bucket_start ? 1 : 0
      );

      // Calendar weeks the student actually trained in — a real elapsed-time
      // figure now, where the old count was "ordinal weeks holding a
      // confirmation" and could exceed the time that had actually passed.
      const weeksActive = weeklyVolume.length;

      // ─── Per-exercise tonnage over time ──────────────────────────────────
      // One point per SESSION per exercise, placed on the day it was trained —
      // finer than the old per-ordinal-week point, and it no longer needs the
      // `program_id:week_id` composite key that existed only to stop week 1 of
      // two different blocks from colliding. A session with no training date
      // has no place on a time axis and is left out.
      // `tonnage` is PERFORMED — Σ(effective
      // reps × effective weight) over DONE sets (actuals override targets),
      // so a student who deviated sees their real numbers, not the plan.
      // An exercise SWAP splits the slot: PLANNED tonnage stays on the coach's
      // original exercise (a dashed reference with no performed bar), while
      // PERFORMED tonnage is credited to the SUBSTITUTE the student actually
      // did (via swapBySlot). Skips are handled (done=false → 0).
      // `plannedTonnage` keeps the prescribed Σ(target_reps × target_weight)
      // as a reference. Bodyweight (null/0) counts as 1kg. Each point carries
      // program_id/program_name so a chart spanning two blocks can label which
      // is which.
      const exerciseMeta = {};   // id → { id, name, type }
      const byExercise = {};     // id → [{ session_id, date, …, tonnage, plannedTonnage, key }]
      for (const w of weeks) {
        for (const s of w.sessions || []) {
          const performedOn = performedOnBySession.get(s.id);
          if (!performedOn) continue;
          const perExercise = {};  // exId → { tonnage, plannedTonnage }
          for (const slot of s.exercise_slots || []) {
            const ex = slot.exercise;
            if (!ex) continue;

            // Prescribed tonnage (reference), from the slot's target logs.
            let planned = 0;
            const targetLogs = slot.set_logs || [];
            if (targetLogs.length > 0) {
              for (const l of targetLogs) {
                if (l.target_reps == null) continue;
                const w_ = l.target_weight_kg && l.target_weight_kg > 0 ? Number(l.target_weight_kg) : 1;
                planned += l.target_reps * w_;
              }
            } else {
              const reps = slot.reps || 0;
              const w_ = slot.weight_kg && slot.weight_kg > 0 ? Number(slot.weight_kg) : 1;
              planned = (slot.sets || 0) * reps * w_;
            }

            // Performed tonnage, from the flat set_logs' actuals on done sets.
            // On a SWAPPED slot the pinned target_weight_kg is the coach's
            // ORIGINAL exercise's load — foreign to the substitute — so use the
            // student's logged actual, else the 1kg bodyweight surrogate. Never
            // import the original prescription's load onto the substitute.
            const isSwapped = swapBySlot.has(slot.id);
            let performed = 0;
            for (const l of perfBySlot.get(slot.id) || []) {
              const reps = performedReps(l, slot);
              if (reps <= 0) continue;
              const wRaw = isSwapped ? l.actual_weight_kg : (l.actual_weight_kg ?? l.target_weight_kg);
              const w_ = wRaw != null && Number(wRaw) > 0 ? Number(wRaw) : 1;
              performed += reps * w_;
            }

            if (planned <= 0 && performed <= 0) continue;
            // Split on a swap: planned → original exercise, performed →
            // substitute. When there's no swap these are the same exercise, so
            // both land on one point (identical to the pre-swap behavior).
            const perfEx = isSwapped ? swapBySlot.get(slot.id) : ex;
            if (planned > 0) {
              exerciseMeta[ex.id] = { id: ex.id, name: ex.name, type: ex.type };
              const a = perExercise[ex.id] || { tonnage: 0, plannedTonnage: 0 };
              a.plannedTonnage += planned;
              // Prescribed, but swapped out that day — label so a 0 performed
              // reads as a swap, not a miss.
              if (isSwapped && performed > 0) a.swappedTo = perfEx.name;
              perExercise[ex.id] = a;
            }
            if (performed > 0) {
              exerciseMeta[perfEx.id] = { id: perfEx.id, name: perfEx.name, type: perfEx.type };
              const b = perExercise[perfEx.id] || { tonnage: 0, plannedTonnage: 0 };
              b.tonnage += performed;
              if (isSwapped) b.swappedFrom = ex.name;
              perExercise[perfEx.id] = b;
            }
          }
          for (const exId of Object.keys(perExercise)) {
            if (!byExercise[exId]) byExercise[exId] = [];
            const acc = perExercise[exId];
            byExercise[exId].push({
              session_id: s.id,
              date: performedOn,
              title: s.title,
              program_id: w.program_id,
              program_name: w.program_name,
              tonnage: acc.tonnage,
              // Only a genuinely prescribed exercise carries a planned reference;
              // a swap-in substitute (planned 0) leaves it undefined so the chart
              // doesn't draw a misleading flat-zero "planned" line.
              plannedTonnage: acc.plannedTonnage > 0 ? acc.plannedTonnage : undefined,
              swappedTo: acc.swappedTo,
              swappedFrom: acc.swappedFrom,
              key: s.id,
            });
          }
        }
      }
      // Chronological, because the x-axis is now time: program order no longer
      // implies date order once the student works at their own pace.
      for (const exId of Object.keys(byExercise)) {
        byExercise[exId].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
      const exerciseProgress = {
        exercises: Object.values(exerciseMeta).sort((a, b) => a.name.localeCompare(b.name)),
        byExercise,
      };

      // Recent confirmations with session metadata.
      const sessionMeta = {};
      for (const w of weeks) {
        for (const s of w.sessions || []) {
          sessionMeta[s.id] = {
            session_title: s.title,
            day_number: s.day_number,
            week_number: w.week_number,
            week_label: w.label,
            program_name: w.program_name,
          };
        }
      }
      const recentConfirmations = confirmations
        .slice(0, 5)
        .map((c) => ({ ...c, ...sessionMeta[c.session_id] }));

      // ─── Session calendar ────────────────────────────────────────────────
      // Trained sessions land on the day they were REALLY trained; open ones
      // on the day they're recommended for. That's the inversion the whole
      // refactor is about — the calendar reports what happened rather than
      // what was supposed to happen. It also means a session trained without
      // any coach-set date finally appears at all, where before an undated
      // session was simply missing from the month view.
      // An archived session is on the calendar only where it was trained: its
      // plan date is not a training date (the legacy rows that have nothing
      // else get theirs from `trainedOn`), and one that was never trained is
      // not on it at all — it is neither done nor still to do.
      const sessionCalendar = [];
      for (const s of countedSessions) {
        const performedOn = performedOnBySession.get(s.id);
        const planned = !s.archived_at && s.scheduled_date ? s.scheduled_date.slice(0, 10) : null;
        const date = performedOn || planned;
        if (!date) continue;
        sessionCalendar.push({
          session_id: s.id,
          title: s.title,
          date,
          completed: performedIds.has(s.id),
        });
      }

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        totalExtraSetsDone,
        weeksActive,
        backlogSessions,
        avgRpe,
        weeklyVolume,
        recentConfirmations,
        sessionCalendar,
        exerciseProgress,
      };
    },
    enabled: enabled && !!(studentId || user?.id),
    // A scope that was never read has no data, and a page that swapped its
    // whole content for a spinner on every change of scope took the selector
    // away with it. So the scope that was shown stands in until the new one
    // is read. NOT plain `keepPreviousData`: the coach's section stays
    // mounted from one athlete to the next, and would show athlete A's
    // figures under athlete B's name while B loads.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[1] === owner ? previousData : undefined,
  });
}
