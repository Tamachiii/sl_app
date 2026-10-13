import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSnapshot, isUnsyncedDraft, markSynced, markUnsynced, unsyncedRev } from './draftTree';

const TREE = {
  id: 'p-1',
  name: 'Off-season',
  status: 'draft',
  submitted_at: null,
  weeks: [
    {
      id: 'w-1',
      week_number: 1,
      label: null,
      sessions: [
        {
          id: 's-1',
          title: 'Day 1',
          day_number: null,
          sort_order: 0,
          exercise_slots: [
            {
              id: 'sl-1',
              exercise_id: 'e-1',
              sets: 3,
              reps: 5,
              weight_kg: null,
              duration_seconds: null,
              rest_seconds: null,
              sort_order: 0,
              exercise: { id: 'e-1', name: 'Pull-up', type: 'pull' },
            },
          ],
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the unsynced marker of a draft tree', () => {
  it('a tree as the server gives it carries none', () => {
    expect(isUnsyncedDraft(TREE)).toBe(false);
    expect(unsyncedRev(TREE)).toBeNull();
  });

  it('no tree at all is not an unsynced one', () => {
    expect(isUnsyncedDraft(undefined)).toBe(false);
    expect(isUnsyncedDraft(null)).toBe(false);
  });

  it('marking leaves the tree it was given alone and names the state by its rev', () => {
    const marked = markUnsynced(TREE, 7);

    expect(marked).not.toBe(TREE);
    expect(isUnsyncedDraft(TREE)).toBe(false);
    expect(isUnsyncedDraft(marked)).toBe(true);
    expect(unsyncedRev(marked)).toBe(7);
    expect(marked.weeks).toBe(TREE.weeks);
  });

  it('marking again replaces the rev: one marker, for the tree as it is now', () => {
    expect(unsyncedRev(markUnsynced(markUnsynced(TREE, 7), 8))).toBe(8);
  });

  it('without a rev of its own a marker gets a fresh one', () => {
    const first = unsyncedRev(markUnsynced(TREE));
    const second = unsyncedRev(markUnsynced(TREE));
    expect(second).toBeGreaterThan(first);
  });

  it('a tree marked as synced is the tree the server holds: no marker left, nothing else changed', () => {
    const synced = markSynced(markUnsynced(TREE, 7));

    expect(synced).toEqual(TREE);
    expect('unsynced' in synced).toBe(false);
  });

  it('marking a tree in sync as synced hands the same tree back', () => {
    expect(markSynced(TREE)).toBe(TREE);
    expect(markSynced(undefined)).toBeUndefined();
    expect(markSynced(null)).toBeNull();
  });

  it('survives the JSON the persister stores the cache as', () => {
    const stored = JSON.parse(JSON.stringify(markUnsynced(TREE, 7)));
    expect(unsyncedRev(stored)).toBe(7);
  });
});

// The counter behind the revs belongs to the module: each test takes the module
// as a page load finds it, at a moment the test chooses.
async function launchedAt(iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  vi.resetModules();
  const fresh = await import('./draftTree');
  return fresh.nextDraftRev;
}

describe('nextDraftRev', () => {
  const MONDAY = Date.parse('2026-10-12T10:00:00.000Z');
  const TUESDAY = Date.parse('2026-10-13T10:00:00.000Z');

  it('never gives the same rev twice, even for edits in the same millisecond', async () => {
    const next = await launchedAt(MONDAY);

    expect([next(), next(), next()]).toEqual([MONDAY, MONDAY + 1, MONDAY + 2]);
  });

  it('follows the clock, so a rev made after a relaunch is larger than the ones stored before it', async () => {
    const monday = await launchedAt(MONDAY);
    const stored = monday();

    const tuesday = await launchedAt(TUESDAY);

    expect(tuesday()).toBe(TUESDAY);
    expect(TUESDAY).toBeGreaterThan(stored);
  });

  it('does not go back when the clock of the phone does', async () => {
    const next = await launchedAt(TUESDAY);
    const before = next();

    vi.setSystemTime(new Date(MONDAY));

    expect(next()).toBe(before + 1);
  });
});

describe('buildSnapshot', () => {
  it('sends nothing the cache keeps for itself: no marker, no exercise meta', () => {
    const snapshot = buildSnapshot(markUnsynced(TREE, 7));

    expect(snapshot).toEqual(buildSnapshot(TREE));
    expect(JSON.stringify(snapshot)).not.toContain('unsynced');
    expect(snapshot.program).toEqual({ id: 'p-1', name: 'Off-season', submitted_at: null });
    expect(Object.keys(snapshot.slots[0]).sort()).toEqual([
      'duration_seconds',
      'exercise_id',
      'id',
      'reps',
      'rest_seconds',
      'session_id',
      'sets',
      'sort_order',
      'weight_kg',
    ]);
  });
});
