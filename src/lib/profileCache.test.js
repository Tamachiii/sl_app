import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROFILE_CACHE_KEY, readCachedProfile, writeCachedProfile, forgetCachedProfile } from './profileCache';

const ROW = { id: 'u-1', role: 'student', full_name: 'Ada Lovelace', created_at: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the profile this device remembers', () => {
  it('is the role and the name of the row that was read, and nothing else of it', () => {
    writeCachedProfile(ROW);

    expect(readCachedProfile('u-1')).toEqual({ id: 'u-1', role: 'student', full_name: 'Ada Lovelace' });
    expect(JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY))).toEqual({
      id: 'u-1',
      role: 'student',
      full_name: 'Ada Lovelace',
    });
  });

  it('is one account\'s: what is stored for another account is not handed to this one', () => {
    writeCachedProfile(ROW);

    expect(readCachedProfile('u-2')).toBeNull();
    expect(readCachedProfile(undefined)).toBeNull();
  });

  it('is replaced by the next account that is read', () => {
    writeCachedProfile(ROW);
    writeCachedProfile({ id: 'u-2', role: 'coach', full_name: 'Coach' });

    expect(readCachedProfile('u-1')).toBeNull();
    expect(readCachedProfile('u-2')).toEqual({ id: 'u-2', role: 'coach', full_name: 'Coach' });
  });

  it('is gone once forgotten', () => {
    writeCachedProfile(ROW);
    forgetCachedProfile();

    expect(readCachedProfile('u-1')).toBeNull();
    expect(localStorage.getItem(PROFILE_CACHE_KEY)).toBeNull();
  });

  it('never hands out a role the app does not have', () => {
    for (const stored of ['not json', 'null', '[]', '{"id":"u-1"}', '{"id":"u-1","role":"admin","full_name":"X"}']) {
      localStorage.setItem(PROFILE_CACHE_KEY, stored);
      expect(readCachedProfile('u-1')).toBeNull();
    }
    writeCachedProfile({ id: 'u-1', role: 'owner', full_name: 'X' });
    writeCachedProfile({ role: 'coach', full_name: 'X' });
    writeCachedProfile(null);
    expect(readCachedProfile('u-1')).toBeNull();
  });

  it('survives a storage that refuses: nothing is remembered, nothing throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(() => writeCachedProfile(ROW)).not.toThrow();
    expect(readCachedProfile('u-1')).toBeNull();
    expect(() => forgetCachedProfile()).not.toThrow();
  });
});
