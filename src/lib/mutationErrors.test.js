import { describe, it, expect } from 'vitest';
import { mutationErrorKey } from './mutationErrors';
import en from './i18n/en';

// Resolve a dotted i18n key against the EN dictionary, asserting it exists.
function resolve(key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en);
}

describe('mutationErrorKey', () => {
  it('maps a foreign-key violation to in-use', () => {
    expect(mutationErrorKey({ code: '23503' })).toBe('errors.inUse');
    expect(mutationErrorKey({ message: 'update violates foreign key constraint' })).toBe('errors.inUse');
  });

  it('maps a check violation on a named constraint to its specific key', () => {
    expect(
      mutationErrorKey({ code: '23514', message: 'violates check constraint "exercise_slots_unit_one_of"' })
    ).toBe('errors.constraint.slotUnit');
  });

  it('maps an unknown check violation to the generic constraint key', () => {
    expect(mutationErrorKey({ code: '23514', message: 'violates check constraint "sets_positive"' }))
      .toBe('errors.constraint.generic');
  });

  it('maps unique violations, RLS, and the app sentinel', () => {
    expect(mutationErrorKey({ code: '23505', message: 'programs_one_active_per_student' }))
      .toBe('errors.constraint.oneActive');
    expect(mutationErrorKey({ code: '42501' })).toBe('errors.notAllowed');
    expect(mutationErrorKey({ code: 'PROGRAM_HAS_LOGGED_SETS' })).toBe('errors.hasLoggedTraining');
    // The DB trigger's P0001 message maps to the same generic line.
    expect(mutationErrorKey({ message: 'week 7 still has 3 logged set(s)' })).toBe('errors.hasLoggedTraining');
  });

  it('falls back to generic so no failure is silent', () => {
    expect(mutationErrorKey(null)).toBe('errors.generic');
    expect(mutationErrorKey({ message: 'network unreachable' })).toBe('errors.generic');
  });

  it('every returned key resolves to a real EN string', () => {
    const samples = [
      null,
      { code: '23503' },
      { code: '23514', message: 'set_logs_done_xor_failed' },
      { code: '23514', message: 'slot_deviations_swap_has_substitute' },
      { code: '23514', message: 'sessions_week_sort_order_unique' },
      { code: '23514', message: 'unknown' },
      { code: '23505', message: 'programs_one_active_per_student' },
      { code: '23505', message: 'unknown' },
      { code: '42501' },
      { code: 'PROGRAM_HAS_LOGGED_SETS' },
      { message: 'whatever' },
    ];
    for (const s of samples) {
      expect(typeof resolve(mutationErrorKey(s))).toBe('string');
    }
  });
});
