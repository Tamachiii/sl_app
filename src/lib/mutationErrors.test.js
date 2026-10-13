import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mutationErrorKey,
  REPLAY_REFUSED_KEY,
  REJECTED_WRITES_KEY,
  REJECTED_WRITES_CAP,
  isClosedToAthlete,
  markRefusedReplay,
  isRefusedReplay,
  readRejectedWrites,
  recordRejectedWrite,
  clearRejectedWrites,
} from './mutationErrors';
import en from './i18n/en';
import { messages, lookupMessage } from './i18n';

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

// What PostgREST answers when the athlete's session was closed while a write
// waited: an UPDATE that matches no row they may write, an INSERT its policy
// turns down.
const NO_ROW = {
  code: 'PGRST116',
  details: 'The result contains 0 rows',
  hint: null,
  message: 'Cannot coerce the result to a single JSON object',
};
const POLICY = {
  code: '42501',
  details: null,
  hint: null,
  message: 'new row violates row-level security policy for table "session_confirmations"',
};

describe('isClosedToAthlete', () => {
  it('knows the two codes by which the database closes a row to its athlete', () => {
    expect(isClosedToAthlete(NO_ROW)).toBe(true);
    expect(isClosedToAthlete(POLICY)).toBe(true);
    expect(isClosedToAthlete({ code: ' 42501 ' })).toBe(true);
  });

  it('and no other answer: a constraint, a missing function, a database that is busy', () => {
    for (const code of ['23514', '23505', '23503', 'P0001', 'PGRST202', 'PGRST002', '57014', '40001']) {
      expect(isClosedToAthlete({ code })).toBe(false);
    }
  });

  it('nor something that is not an answer of the database at all', () => {
    expect(isClosedToAthlete(null)).toBe(false);
    expect(isClosedToAthlete(undefined)).toBe(false);
    expect(isClosedToAthlete(new TypeError('Failed to fetch'))).toBe(false);
    expect(isClosedToAthlete({ message: 'TypeError: Failed to fetch', code: '' })).toBe(false);
    // The numeric `code` of a DOMException is not an SQLSTATE.
    expect(isClosedToAthlete({ code: 42501 })).toBe(false);
  });
});

describe('a refused replay, as an error', () => {
  it('is the error that was marked, and only that object', () => {
    const refused = { ...NO_ROW };
    expect(isRefusedReplay(refused)).toBe(false);

    expect(markRefusedReplay(refused)).toBe(refused);

    expect(isRefusedReplay(refused)).toBe(true);
    // The same answer for a write that had not waited is another object.
    expect(isRefusedReplay({ ...NO_ROW })).toBe(false);
    expect(isRefusedReplay(JSON.parse(JSON.stringify(refused)))).toBe(false);
  });

  it('takes anything without throwing', () => {
    for (const value of [null, undefined, 'PGRST116', 42501]) {
      expect(markRefusedReplay(value)).toBe(value);
      expect(isRefusedReplay(value)).toBe(false);
    }
  });

  it('has its own line, where the same code is otherwise "not allowed" or "try again"', () => {
    expect(mutationErrorKey(NO_ROW)).toBe('errors.generic');
    expect(mutationErrorKey(POLICY)).toBe('errors.notAllowed');

    expect(mutationErrorKey(markRefusedReplay({ ...NO_ROW }))).toBe(REPLAY_REFUSED_KEY);
    expect(mutationErrorKey(markRefusedReplay({ ...POLICY }))).toBe(REPLAY_REFUSED_KEY);
  });

  it('a line that exists in the three languages, each in its own words', () => {
    const lines = ['en', 'fr', 'de'].map((lang) => lookupMessage(messages, lang, REPLAY_REFUSED_KEY));
    for (const line of lines) {
      expect(line).not.toBe(REPLAY_REFUSED_KEY);
      expect(line.length).toBeGreaterThan(40);
    }
    expect(new Set(lines).size).toBe(3);
  });
});

describe('the journal of refused writes', () => {
  const entry = (n) => ({
    refused_at: '2026-10-12T07:30:00.000Z',
    made_at: '2026-10-09T18:02:11.000Z',
    user_id: 'u-1',
    write: 'toggleDone',
    variables: { logId: `l-${n}`, done: true, at: '2026-10-09T18:02:11.000Z' },
    code: 'PGRST116',
    message: NO_ROW.message,
  });

  beforeEach(() => {
    localStorage.removeItem(REJECTED_WRITES_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(REJECTED_WRITES_KEY);
  });

  it('is empty on a device that never had a write refused', () => {
    expect(readRejectedWrites()).toEqual([]);
  });

  it('keeps the writes in the order they were refused, under the documented key', () => {
    expect(recordRejectedWrite(entry(1))).toBe(true);
    expect(recordRejectedWrite(entry(2))).toBe(true);

    expect(readRejectedWrites()).toEqual([entry(1), entry(2)]);
    // What someone reading the device back will look for.
    expect(REJECTED_WRITES_KEY).toBe('sl_rejected_writes');
    expect(JSON.parse(localStorage.getItem('sl_rejected_writes'))).toEqual([entry(1), entry(2)]);
  });

  it('is capped: the oldest entries leave first', () => {
    for (let n = 1; n <= REJECTED_WRITES_CAP + 5; n += 1) recordRejectedWrite(entry(n));

    const journal = readRejectedWrites();
    expect(journal).toHaveLength(REJECTED_WRITES_CAP);
    expect(journal[0].variables.logId).toBe('l-6');
    expect(journal.at(-1).variables.logId).toBe(`l-${REJECTED_WRITES_CAP + 5}`);
  });

  it('starts again from nothing when what is stored is not a journal', () => {
    for (const stored of ['{"not":"a list"}', 'not json', '42', 'null']) {
      localStorage.setItem(REJECTED_WRITES_KEY, stored);
      expect(readRejectedWrites()).toEqual([]);
    }

    localStorage.setItem(REJECTED_WRITES_KEY, 'not json');
    expect(recordRejectedWrite(entry(1))).toBe(true);
    expect(readRejectedWrites()).toEqual([entry(1)]);
  });

  it('never throws on a device that stores nothing: it says so and goes on', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(readRejectedWrites()).toEqual([]);
    expect(recordRejectedWrite(entry(1))).toBe(false);
    expect(() => clearRejectedWrites()).not.toThrow();
  });

  it('can be emptied', () => {
    recordRejectedWrite(entry(1));

    clearRejectedWrites();

    expect(readRejectedWrites()).toEqual([]);
    expect(localStorage.getItem(REJECTED_WRITES_KEY)).toBeNull();
  });
});
