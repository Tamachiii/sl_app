import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { computeSessionVolume } from '../lib/volume';
import { addDays, isoDate, parseISODate, startOfWeekMonday } from '../lib/day';

/**
 * Aggregates everything the Student Stats page needs in a single fetch:
 *   - weeks[] with sessions + slots + exercise metadata (for volume maths)
 *   - confirmedSessionIds (Set)
 *   - setLogsBySlotId (for counting done sets, avg RPE, and weight history)
 *
 * Stats are scoped via the `scope` parameter:
 *   - 'all'      → every program the student has ever been enrolled in (default)
 *   - 'active'   → only the currently-active program (legacy block-local view)
 *   - <programId> → a single specific program (active or past)
 *
 * Everything time-based is bucketed by the REAL CALENDAR WEEK the student
 * trained in (Mon–Sun of `sessions.performed_at`), not by the ordinal training
 * week the session was authored under. A block stretched over ten days used to
 * land in a bucket that corresponded to no actual seven-day span; now the
 * chart shows the weeks the student lived. Work that hasn't been done yet has
 * no date, so it never enters a time bucket — it is counted as backlog.
 *
 * Returns derived stats:
 *   - totalSessionsConfirmed, totalSessions
 *   - totalSetsDone, totalSets
 *   - weeksActive       (calendar weeks in which at least one session was trained)
 *   - backlogSessions   (open sessions with no training date yet)
 *   - avgRpe            (across sets with rpe logged)
 *   - recentConfirmations[] (last 5, newest first)
 *   - weeklyVolume[]    [{ bucket_start, bucket_end, pull, push, *_planned, sets_done, sets_prescribed, sessions_confirmed }]
 *   - sessionCalendar[] [{ session_id, title, date, completed }] — performed sessions on their REAL date, open ones on their recommended date
 *
 * Pass a `studentId` (students.id row id) to stat any student — used by the
 * coach Students view. Omit it to stat the signed-in user (student flow).
 */
export function useStudentProgressStats(studentId, scope = 'all') {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-progress-stats', studentId ?? user?.id, scope],
    queryFn: async () => {
      // 1. Resolve the student row. Coach view passes studentId directly;
      //    student view looks it up via profile_id.
      let resolvedStudentId = studentId;
      if (!resolvedStudentId) {
        const { data: student, error: stErr } = await supabase
          .from('students')
          .select('id')
          .eq('profile_id', user.id)
          .single();
        if (stErr) throw stErr;
        resolvedStudentId = student.id;
      }

      // 2. Fetch program(s) → weeks → sessions → slots → exercise meta.
      //    The scope parameter swaps the program filter:
      //      - specific id  → single program by id (RLS enforces ownership)
      //      - 'active'     → only the active block (block-local stats)
      //      - 'all'        → every program for this student
      let q = supabase
        .from('programs')
        .select(`
          id, name, sort_order, is_active,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, scheduled_date, archived_at, performed_at,
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

      if (scope === 'active') {
        q = q.eq('is_active', true);
      } else if (scope !== 'all') {
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
        if (scope === 'active') out = out.eq(`${prefix}.is_active`, true);
        else if (scope !== 'all') out = out.eq(`${prefix}.id`, scope);
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

      for (const prog of programs || []) {
        const sortedWeeks = (prog.weeks || [])
          .slice()
          .sort((a, b) => a.week_number - b.week_number);
        for (const w of sortedWeeks) {
          // Include archived sessions in every aggregate — completed work
          // shouldn't vanish from stats if the coach later archives the session.
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
      const hasSessions = allSessions.length > 0;
      const hasSlots = allSlotIds.length > 0;

      const { data: confRows, error: confErr } = hasSessions
        ? await applyProgramScope(
            supabase
              .from('session_confirmations')
              .select(
                'id, session_id, confirmed_at, performed_on, notes, sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at)))'
              ),
            'sessions.weeks.programs'
          ).order('confirmed_at', { ascending: false })
        : { data: [], error: null };
      if (confErr) throw confErr;
      const confirmations = confRows || [];
      const confirmedIds = new Set(confirmations.map((c) => c.session_id));

      const { data: logRows, error: logErr } = hasSlots
        ? await applyProgramScope(
            supabase
              .from('set_logs')
              .select(
                'id, exercise_slot_id, set_number, done, failed, skipped, is_student_added, rpe, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg, exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at))))'
              )
              // Explicit high cap: performed metrics come from this flat query
              // while planned comes from the tree, so a silent PostgREST
              // default-row truncation would undercount performed and make a
              // long-tenured student look like they stopped. The real fix is a
              // server-side stats RPC (roadmap); this pushes the cap well past
              // realistic single-student volume in the meantime.
              .limit(20000),
            'exercise_slots.sessions.weeks.programs'
          )
        : { data: [], error: null };
      if (logErr) throw logErr;
      const setLogs = logRows || [];

      // 3b. Swap deviations for the in-scope slots, with the substitute
      //     exercise's metadata. Lets PERFORMED volume/tonnage follow an
      //     exercise SWAP to what the student actually did, instead of
      //     crediting the coach's original prescription. slot_deviations has a
      //     single FK to exercise_library (substitute_exercise_id), so the
      //     `substitute:exercise_library(...)` embed is unambiguous.
      const { data: devRows, error: devErr } = hasSlots
        ? await applyProgramScope(
            supabase
              .from('slot_deviations')
              .select(
                'exercise_slot_id, kind, substitute:exercise_library(id, name, type, difficulty, volume_weight), exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at))))'
              )
              .eq('kind', 'swap')
              // Match the set_logs cap so a heavy-deviation student can't have
              // swaps silently truncated (which would undercount performed work).
              .limit(20000),
            'exercise_slots.sessions.weeks.programs'
          )
        : { data: [], error: null };
      if (devErr) throw devErr;
      // slotId → substitute exercise meta ({id, name, type, difficulty,
      // volume_weight}). Only 'swap' rows carry a substitute; skips are already
      // reflected as done=false set_logs (0 performed).
      const swapBySlot = new Map();
      for (const d of devRows || []) {
        if (d.kind === 'swap' && d.substitute) swapBySlot.set(d.exercise_slot_id, d.substitute);
      }

      // Performance index: every set_log's actuals keyed by slot, so the
      // weekly-volume and per-exercise charts can reflect PERFORMED work
      // (what the student actually did — actuals override targets, skips and
      // undone sets count 0) instead of the coach's prescription alone. This
      // is what makes the off-plan actuals + deviations features visible in
      // the motivation loop.
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
      const performedReps = (l) => (l.done ? (l.actual_reps ?? l.target_reps ?? 0) : 0);
      // NOTE: performed LOAD is computed inline in the per-exercise tonnage loop
      // (not a shared helper) because a SWAPPED slot must not fall back to the
      // pinned target_weight_kg — that's the coach's ORIGINAL exercise's load.

      // ─── Derived aggregates ───────────────────────────────────────────────

      // A session counts as "completed" if it's confirmed OR archived (archiving
      // happens after the coach reviews a confirmed session, and legacy sessions
      // may have been archived without ever getting a confirmation row).
      const isCompleted = (s) => confirmedIds.has(s.id) || !!s.archived_at;

      // ─── When each session was actually trained ──────────────────────────
      // The one date every time-based aggregate below keys off. Preference
      // order runs from most to least truthful:
      //   1. sessions.performed_at — the day the student trained, derived from
      //      the set logs at confirm time (survives an offline queue intact).
      //   2. the confirmation's performed_on / confirmed_at — for rows written
      //      before performed_at existed. confirmed_at is the REPLAY moment for
      //      an offline confirm, so it is a fallback, never the primary.
      //   3. scheduled_date, only for a session archived without ever being
      //      confirmed — legacy shape, and the plan date is all it has.
      // A session with none of these has no place on a timeline and is counted
      // as backlog rather than being parked on an invented date.
      const confBySession = new Map();
      for (const c of confirmations) confBySession.set(c.session_id, c);

      const localDay = (stamp) => {
        if (!stamp) return null;
        const d = new Date(stamp);
        return Number.isNaN(d.getTime()) ? null : isoDate(d);
      };

      const performedOnBySession = new Map();
      for (const s of allSessions) {
        const conf = confBySession.get(s.id);
        const on =
          localDay(s.performed_at) ||
          (conf?.performed_on ? conf.performed_on.slice(0, 10) : null) ||
          localDay(conf?.confirmed_at) ||
          (s.archived_at && s.scheduled_date ? s.scheduled_date.slice(0, 10) : null);
        if (on) performedOnBySession.set(s.id, on);
      }

      // Monday of the real calendar week a session was trained in.
      const bucketOf = (sessionId) => {
        const on = performedOnBySession.get(sessionId);
        if (!on) return null;
        const d = parseISODate(on);
        return d ? isoDate(startOfWeekMonday(d)) : null;
      };

      const totalSessions = allSessions.length;
      const totalSessionsConfirmed = allSessions.filter(isCompleted).length;
      const totalSetsDone = setLogs.filter((l) => l.done).length;

      let totalSets = 0;
      for (const s of allSessions) {
        for (const slot of s.exercise_slots || []) {
          totalSets += slot.sets || 0;
        }
      }

      const rpeSamples = setLogs.filter((l) => l.done && l.rpe != null).map((l) => l.rpe);
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
            sets_prescribed: 0,
            sessions_confirmed: 0,
          };
          bucketMap.set(key, acc);
        }
        return acc;
      };

      let backlogSessions = 0;
      for (const s of allSessions) {
        const key = bucketOf(s.id);
        if (!key) {
          if (!s.archived_at) backlogSessions += 1;
          continue;
        }
        const acc = bucketFor(key);
        acc.sessions_confirmed += 1;

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
          for (const l of perf) doneReps += performedReps(l);
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
              const reps = performedReps(l);
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
      const sessionCalendar = [];
      for (const s of allSessions) {
        const performedOn = performedOnBySession.get(s.id);
        const date = performedOn || (s.scheduled_date ? s.scheduled_date.slice(0, 10) : null);
        if (!date) continue;
        sessionCalendar.push({
          session_id: s.id,
          title: s.title,
          date,
          completed: isCompleted(s),
        });
      }

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        weeksActive,
        backlogSessions,
        avgRpe,
        weeklyVolume,
        recentConfirmations,
        sessionCalendar,
        exerciseProgress,
      };
    },
    enabled: !!(studentId || user?.id),
  });
}
