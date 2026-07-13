// Map a Supabase/Postgres error into a friendly i18n key for the global
// error toast. Coach mutations used to fail silently — a constraint rejection
// (delete an in-use exercise, set sets to 0) did nothing, leaving stale UI.
// This turns the raw error into one readable line.
//
// Matching is on Postgres SQLSTATE codes where available (stable) plus
// constraint-name / message substrings (our own names, also stable). Anything
// unrecognized falls back to a generic "couldn't save" key so no failure is
// ever fully silent.

const CONSTRAINT_KEYS = {
  // Our named CHECK/؜UNIQUE constraints (see schema.sql).
  set_logs_done_xor_failed: 'errors.constraint.setState',
  set_logs_no_rpe_when_failed: 'errors.constraint.setState',
  set_logs_skipped_not_resolved: 'errors.constraint.setState',
  exercise_slots_unit_one_of: 'errors.constraint.slotUnit',
  slot_deviations_swap_has_substitute: 'errors.constraint.deviation',
  sessions_week_sort_order_unique: 'errors.constraint.sessionOrder',
  programs_one_active_per_student: 'errors.constraint.oneActive',
};

export function mutationErrorKey(error) {
  if (!error) return 'errors.generic';
  const code = error.code || error.details?.code;
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();

  // The DB triggers (program/week/session) RAISE "… still has N logged
  // set(s) …" (SQLSTATE P0001), and useHardDeleteProgram throws the same-
  // meaning sentinel. Both map to one generic "archive instead" line — the
  // global toast fires for week/session deletes; the program hard-delete
  // opts out (skipErrorToast) and shows its own inline copy.
  if (error.code === 'PROGRAM_HAS_LOGGED_SETS') return 'errors.hasLoggedTraining';
  if (msg.includes('logged set')) return 'errors.hasLoggedTraining';

  // Foreign-key violation: the row is still referenced (e.g. deleting a
  // library exercise that a slot or goal points at).
  if (code === '23503' || msg.includes('foreign key') || msg.includes('still referenced')) {
    return 'errors.inUse';
  }
  // Check-constraint violation (23514) — sets ≤ 0, bad unit, etc.
  if (code === '23514') {
    for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
      if (msg.includes(name)) return key;
    }
    return 'errors.constraint.generic';
  }
  // Unique violation (23505).
  if (code === '23505') {
    for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
      if (msg.includes(name)) return key;
    }
    return 'errors.duplicate';
  }
  // RLS / permission.
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission denied')) {
    return 'errors.notAllowed';
  }
  // Named constraint mentioned without a recognized code.
  for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
    if (msg.includes(name)) return key;
  }
  return 'errors.generic';
}
