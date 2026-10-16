import { describe, it, expect, beforeEach } from 'vitest';
import {
  exerciseStorageKey,
  NO_ACTIVE_BLOCK,
  readStatsPrefs,
  resolveStatsScope,
  saveStatsScope,
  scopeReachesToday,
  settleSavedScope,
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

// B41: the selector offers the active block by its id, so a block picked as
// "the one I am training" stayed on screen after the coach made the next one
// active, and the athlete's new training never showed.
describe('resolveStatsScope — a saved block replaced by a new active block', () => {
  // The coach has made Block C active since.
  const later = [
    { id: 'p-1', name: 'Block A', is_active: false, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
    { id: 'p-3', name: 'Block C', is_active: true, sort_order: 2 },
  ];
  const resolve = (over) => resolveStatsScope({ urlScope: '', programs: later, ...over });

  it('computes "all", and says to forget it, for a block picked while it was the active one', () => {
    expect(resolve({ savedScope: 'p-1', savedActiveBlock: 'p-1' }))
      .toEqual({ scope: 'all', resolved: true, reset: true });
  });

  it('does the same for a past block picked while another block was active', () => {
    expect(resolve({ savedScope: 'p-2', savedActiveBlock: 'p-1' }))
      .toEqual({ scope: 'all', resolved: true, reset: true });
    expect(resolve({ savedScope: 'p-2', savedActiveBlock: NO_ACTIVE_BLOCK }))
      .toEqual({ scope: 'all', resolved: true, reset: true });
  });

  it('waits for the list before it decides anything', () => {
    expect(resolve({ savedScope: 'p-1', savedActiveBlock: 'p-1', programs: undefined }))
      .toEqual({ scope: 'p-1', resolved: false });
    expect(resolve({
      savedScope: 'p-1', savedActiveBlock: 'p-1', programs: undefined, listUnavailable: true,
    })).toEqual({ scope: 'all', resolved: true });
  });

  it.each([
    ['the block active when it was picked is still the active one', { savedScope: 'p-2', savedActiveBlock: 'p-3' }, 'p-2'],
    ['the saved block is the active one now', { savedScope: 'p-3', savedActiveBlock: 'p-1' }, 'p-3'],
    ['it was saved before the marker existed', { savedScope: 'p-1' }, 'p-1'],
    ['the marker is not an id', { savedScope: 'p-1', savedActiveBlock: 42 }, 'p-1'],
    ['the URL names the block', { urlScope: 'p-1', savedScope: 'p-1', savedActiveBlock: 'p-1' }, 'p-1'],
    ['the scope is "active"', { savedScope: 'active', savedActiveBlock: 'p-1' }, 'active'],
  ])('keeps the scope when %s', (_name, over, scope) => {
    expect(resolve(over)).toEqual({ scope, resolved: true });
  });

  it('keeps a saved block while no block at all is active', () => {
    const none = later.map((p) => ({ ...p, is_active: false }));
    expect(resolve({ savedScope: 'p-1', savedActiveBlock: 'p-1', programs: none }))
      .toEqual({ scope: 'p-1', resolved: true });
  });
});

describe('saveStatsScope and settleSavedScope', () => {
  const key = 'sl_stats_prefs:self';
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves a block with the block active at that moment', () => {
    saveStatsScope(key, 'p-2', programs);
    expect(readStatsPrefs(key)).toEqual({ scope: 'p-2', activeBlock: 'p-1' });
    saveStatsScope(key, 'p-1', programs);
    expect(readStatsPrefs(key)).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
  });

  it('says so when no block was active', () => {
    saveStatsScope(key, 'p-2', programs.map((p) => ({ ...p, is_active: false })));
    expect(readStatsPrefs(key)).toEqual({ scope: 'p-2', activeBlock: NO_ACTIVE_BLOCK });
  });

  it('forgets both for "all", and keeps no block for "active"', () => {
    saveStatsScope(key, 'p-2', programs);
    saveStatsScope(key, 'all', programs);
    expect(readStatsPrefs(key)).toEqual({});
    saveStatsScope(key, 'active', programs);
    expect(readStatsPrefs(key)).toEqual({ scope: 'active' });
  });

  it('forgets the saved scope on a reset, and nothing else', () => {
    localStorage.setItem(key, JSON.stringify({ scope: 'p-1', activeBlock: 'p-1', other: 1 }));
    settleSavedScope(key, { reset: true, programs });
    expect(readStatsPrefs(key)).toEqual({ other: 1 });
  });

  it('stamps a block saved before the marker with the block active now', () => {
    localStorage.setItem(key, JSON.stringify({ scope: 'p-2' }));
    settleSavedScope(key, { programs });
    expect(readStatsPrefs(key)).toEqual({ scope: 'p-2', activeBlock: 'p-1' });
    // Once stamped, the next new block replaces it.
    const later = [...programs.map((p) => ({ ...p, is_active: false })), { id: 'p-3', is_active: true }];
    const prefs = readStatsPrefs(key);
    expect(resolveStatsScope({
      urlScope: '', savedScope: prefs.scope, savedActiveBlock: prefs.activeBlock, programs: later,
    })).toEqual({ scope: 'all', resolved: true, reset: true });
  });

  it.each([
    ['a stamped block', { scope: 'p-2', activeBlock: 'p-2' }, programs],
    ['a block the list does not have', { scope: 'p-gone' }, programs],
    ['a block, with no list', { scope: 'p-2' }, undefined],
    ['"active"', { scope: 'active' }, programs],
    ['nothing', {}, programs],
  ])('leaves %s as it is', (_name, prefs, list) => {
    localStorage.setItem(key, JSON.stringify(prefs));
    settleSavedScope(key, { programs: list });
    expect(readStatsPrefs(key)).toEqual(prefs);
  });
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
