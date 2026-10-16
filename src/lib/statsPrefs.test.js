import { describe, it, expect, beforeEach } from 'vitest';
import {
  exerciseStorageKey,
  readStatsPrefs,
  resolveStatsScope,
  scopeReachesToday,
  statsPrefsKey,
  writeStatsPref,
} from './statsPrefs';

const programs = [
  { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
  { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
];

describe('resolveStatsScope', () => {
  it('is "all", known at once, when nothing was asked for', () => {
    expect(resolveStatsScope({ urlScope: '', savedScope: undefined, programs: undefined }))
      .toEqual({ scope: 'all', resolved: true });
  });

  it.each(['all', 'active'])('knows "%s" without the programs list', (wanted) => {
    expect(resolveStatsScope({ urlScope: wanted, savedScope: undefined, programs: undefined }))
      .toEqual({ scope: wanted, resolved: true });
    expect(resolveStatsScope({ urlScope: '', savedScope: wanted, programs: undefined }))
      .toEqual({ scope: wanted, resolved: true });
  });

  // The case the function exists for: the page must not compute 'all' while
  // it waits to learn that the saved block is still there.
  it('does not know a saved program id until the programs list is read', () => {
    expect(resolveStatsScope({ urlScope: '', savedScope: 'p-2', programs: undefined }))
      .toEqual({ scope: 'p-2', resolved: false });
    expect(resolveStatsScope({ urlScope: 'p-2', savedScope: undefined, programs: undefined }))
      .toEqual({ scope: 'p-2', resolved: false });
  });

  it('keeps a program id the list has', () => {
    expect(resolveStatsScope({ urlScope: '', savedScope: 'p-2', programs }))
      .toEqual({ scope: 'p-2', resolved: true });
  });

  it('falls back to "all" for a program id the list does not have', () => {
    expect(resolveStatsScope({ urlScope: '', savedScope: 'p-gone', programs }))
      .toEqual({ scope: 'all', resolved: true });
    expect(resolveStatsScope({ urlScope: 'p-gone', savedScope: 'p-2', programs }))
      .toEqual({ scope: 'all', resolved: true });
    expect(resolveStatsScope({ urlScope: '', savedScope: 'p-2', programs: [] }))
      .toEqual({ scope: 'all', resolved: true });
  });

  it('lets the URL win over what was saved', () => {
    expect(resolveStatsScope({ urlScope: 'p-1', savedScope: 'p-2', programs }))
      .toEqual({ scope: 'p-1', resolved: true });
    expect(resolveStatsScope({ urlScope: 'active', savedScope: 'p-2', programs: undefined }))
      .toEqual({ scope: 'active', resolved: true });
  });

  // A list that failed or is paused would otherwise leave the page on its
  // spinner for as long as the list stays away.
  it('does not wait for a list that is not coming: it computes "all"', () => {
    expect(resolveStatsScope({
      urlScope: '', savedScope: 'p-2', programs: undefined, listUnavailable: true,
    })).toEqual({ scope: 'all', resolved: true });
  });

  it('goes by the list when it is there, even if a later read of it failed', () => {
    expect(resolveStatsScope({
      urlScope: '', savedScope: 'p-2', programs, listUnavailable: true,
    })).toEqual({ scope: 'p-2', resolved: true });
  });

  it.each([[42], [{ id: 'p-2' }], [null], [''], [true]])(
    'ignores a saved scope that is not an id (%j)',
    (savedScope) => {
      expect(resolveStatsScope({ urlScope: '', savedScope, programs: undefined }))
        .toEqual({ scope: 'all', resolved: true });
    },
  );
});

describe('scopeReachesToday', () => {
  it('is true for "all", "active" and the active block, false for a past block', () => {
    expect(scopeReachesToday('all', programs)).toBe(true);
    expect(scopeReachesToday('all', undefined)).toBe(true);
    expect(scopeReachesToday('active', programs)).toBe(true);
    expect(scopeReachesToday('p-1', programs)).toBe(true);
    expect(scopeReachesToday('p-2', programs)).toBe(false);
    expect(scopeReachesToday('p-1', undefined)).toBe(false);
  });
});

describe('stats prefs storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keys the athlete\'s own page and each coached athlete apart', () => {
    expect(statsPrefsKey({ surface: 'self' })).toBe('sl_stats_prefs:self');
    expect(statsPrefsKey({ surface: 'coach', studentId: 'st-1' })).toBe('sl_stats_prefs:coach:st-1');
    expect(exerciseStorageKey('sl_stats_prefs:self')).toBe('sl_stats_prefs:self:exerciseId');
  });

  it('reads back what was written, and forgets a field written as null', () => {
    const key = statsPrefsKey({ surface: 'self' });
    expect(readStatsPrefs(key)).toBeNull();
    writeStatsPref(key, 'scope', 'p-2');
    expect(readStatsPrefs(key)).toEqual({ scope: 'p-2' });
    writeStatsPref(key, 'scope', null);
    expect(readStatsPrefs(key)).toEqual({});
  });

  it('reads nothing from an entry that is not an object', () => {
    localStorage.setItem('sl_stats_prefs:self', 'not json');
    expect(readStatsPrefs('sl_stats_prefs:self')).toBeNull();
    localStorage.setItem('sl_stats_prefs:self', '"p-2"');
    expect(readStatsPrefs('sl_stats_prefs:self')).toBeNull();
  });
});
