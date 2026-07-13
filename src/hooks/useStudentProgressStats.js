import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { computeSessionVolume } from '../lib/volume';

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
 * Returns derived stats:
 *   - totalSessionsConfirmed, totalSessions
 *   - totalSetsDone, totalSets
 *   - weeksActive       (weeks that have >= 1 confirmation)
 *   - avgRpe            (across sets with rpe logged)
 *   - recentConfirmations[] (last 5, newest first)
 *   - weeklyVolume[]    [{ week_id, week_number, label, program_id, program_name, pull, push, sessions_confirmed, sessions_total }]
 *   - sessionCalendar[] [{ session_id, title, date, completed }] — sessions w/ scheduled_date
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
              id, title, day_number, sort_order, scheduled_date, archived_at,
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
                'id, session_id, confirmed_at, notes, sessions!inner(weeks!inner(programs!inner(id, student_id, is_active, deleted_at)))'
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
      const performedReps = (l) => (l.done ? (l.actual_reps ?? l.target_reps ?? 0) : 0);
      // Effective load for tonnage: actual overrides target; bodyweight
      // (null / 0) counts as 1kg so the curve stays visible.
      const performedWeight = (l) => {
        const w = l.actual_weight_kg ?? l.target_weight_kg;
        return w != null && Number(w) > 0 ? Number(w) : 1;
      };

      // ─── Derived aggregates ───────────────────────────────────────────────

      // A session counts as "completed" if it's confirmed OR archived (archiving
      // happens after the coach reviews a confirmed session, and legacy sessions
      // may have been archived without ever getting a confirmation row).
      const isCompleted = (s) => confirmedIds.has(s.id) || !!s.archived_at;

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

      // Weekly volume + confirmation counts.
      // Volume uses volumeSessions (all sessions incl. archived) so archiving a
      // session doesn't make its prescribed load vanish from the chart.
      // Progress counts use sessions (non-archived only).
      const weeklyVolume = weeks.map((w) => {
        // Prescribed volume (planned) — reference line.
        let pull = 0;
        let push = 0;
        // Performed volume (what was actually done) — the primary bar.
        let pullDone = 0;
        let pushDone = 0;
        // Adherence: done vs prescribed sets across the week.
        let setsPrescribed = 0;
        let setsDone = 0;
        for (const s of w.volumeSessions || []) {
          const v = computeSessionVolume(s.exercise_slots || []);
          pull += v.pull;
          push += v.push;
          for (const slot of s.exercise_slots || []) {
            const ex = slot.exercise;
            const perf = perfBySlot.get(slot.id) || [];
            setsPrescribed += slot.sets || 0;
            // Adherence measures the PRESCRIBED work done, so student-added
            // extra sets don't push it over 100% (they're bonus, and
            // sets_prescribed never counts them). They still count toward
            // performed volume/tonnage below — that's real work.
            setsDone += perf.filter((l) => l.done && !l.is_student_added).length;
            if (!ex || !ex.type) continue;
            // Performed training volume mirrors computeSessionVolume's
            // difficulty × reps × volume_weight, but sums ACTUAL reps of
            // done sets instead of prescribed reps.
            let doneReps = 0;
            for (const l of perf) doneReps += performedReps(l);
            if (doneReps <= 0) continue;
            const vol = ex.difficulty * doneReps * Number(ex.volume_weight);
            if (ex.type === 'pull') pullDone += vol;
            else if (ex.type === 'push') pushDone += vol;
          }
        }
        let sessionsConfirmed = 0;
        for (const s of w.sessions || []) {
          if (isCompleted(s)) sessionsConfirmed += 1;
        }
        return {
          week_id: w.id,
          week_number: w.week_number,
          label: w.label,
          program_id: w.program_id,
          program_name: w.program_name,
          program_is_active: w.program_is_active,
          // Performed (primary); prescribed kept as *_planned for the ghost.
          pull: pullDone,
          push: pushDone,
          pull_planned: pull,
          push_planned: push,
          sets_done: setsDone,
          sets_prescribed: setsPrescribed,
          sessions_confirmed: sessionsConfirmed,
          sessions_total: (w.sessions || []).length,
        };
      });

      const weeksActive = weeklyVolume.filter((w) => w.sessions_confirmed > 0).length;

      // ─── Per-exercise weekly tonnage ─────────────────────────────────────
      // One point per week per exercise. `tonnage` is PERFORMED — Σ(effective
      // reps × effective weight) over DONE sets (actuals override targets),
      // so a student who deviated sees their real numbers, not the plan.
      // KNOWN LIMITATION: an exercise SWAP (slot_deviations.substitute_
      // exercise_id) still credits performed work to the slot's ORIGINAL
      // exercise, because this hook doesn't read slot_deviations. Skips are
      // handled (done=false → 0). Correct swap attribution is deferred to the
      // deviation-aware-stats follow-up (needs the substitute's metadata).
      // `plannedTonnage` keeps the prescribed Σ(target_reps × target_weight)
      // as a reference. Bodyweight (null/0) counts as 1kg. Each point carries
      // program_id/program_name + a stable `key` so the chart can render
      // multiple programs side-by-side without colliding on week_number.
      const exerciseMeta = {};   // id → { id, name, type }
      const byExercise = {};     // id → [{ week_id, week_number, …, tonnage, plannedTonnage, key }]
      for (const w of weeks) {
        const perExercise = {};  // exId → { tonnage, plannedTonnage }
        for (const s of w.sessions || []) {
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
            let performed = 0;
            for (const l of perfBySlot.get(slot.id) || []) {
              const reps = performedReps(l);
              if (reps <= 0) continue;
              performed += reps * performedWeight(l);
            }

            if (planned <= 0 && performed <= 0) continue;
            exerciseMeta[ex.id] = { id: ex.id, name: ex.name, type: ex.type };
            const acc = perExercise[ex.id] || { tonnage: 0, plannedTonnage: 0 };
            acc.tonnage += performed;
            acc.plannedTonnage += planned;
            perExercise[ex.id] = acc;
          }
        }
        for (const exId of Object.keys(perExercise)) {
          if (!byExercise[exId]) byExercise[exId] = [];
          byExercise[exId].push({
            week_id: w.id,
            week_number: w.week_number,
            label: w.label,
            program_id: w.program_id,
            program_name: w.program_name,
            tonnage: perExercise[exId].tonnage,
            plannedTonnage: perExercise[exId].plannedTonnage,
            key: `${w.program_id}:${w.id}`,
          });
        }
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
      // Flatten scheduled sessions for the month calendar. Each entry is
      // keyed by its scheduled_date (YYYY-MM-DD) and flagged completed or
      // upcoming. Sessions without scheduled_date are omitted.
      const sessionCalendar = [];
      for (const s of allSessions) {
        if (!s.scheduled_date) continue;
        sessionCalendar.push({
          session_id: s.id,
          title: s.title,
          date: s.scheduled_date,
          completed: isCompleted(s),
        });
      }

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        weeksActive,
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
