import { describe, it, expect } from 'vitest';
import { readState } from './readState';

// Reads as `useQuery` reports them.
const holds = (data) => ({ data, fetchStatus: 'idle', isPaused: false, isError: false });
const onItsWay = { data: undefined, fetchStatus: 'fetching', isPaused: false, isError: false };
const waiting = { data: undefined, fetchStatus: 'paused', isPaused: true, isError: false };
const failed = { data: undefined, fetchStatus: 'idle', isPaused: false, isError: true };
const notAsked = { data: undefined, fetchStatus: 'idle', isPaused: false, isError: false };

const ONLINE = { online: true, restoring: false };
const OFFLINE = { online: false, restoring: false };

describe('readState', () => {
  it('is ready when every read holds data — an empty answer is an answer', () => {
    expect(readState([holds({ weeks: [] }), holds([])], ONLINE)).toBe('ready');
    expect(readState([holds(0), holds(false), holds('')], ONLINE)).toBe('ready');
    expect(readState([], ONLINE)).toBe('ready');
  });

  // A refresh that failed, or that waits for the network, leaves the last good
  // answer in place: that answer is what the page shows.
  it('lets data win over whatever happened to the read since', () => {
    const stale = { ...holds([1]), isError: true };
    const refreshing = { ...holds([1]), fetchStatus: 'fetching' };
    const held = { ...holds([1]), fetchStatus: 'paused', isPaused: true };

    expect(readState([stale, refreshing, held], ONLINE)).toBe('ready');
    expect(readState([stale, refreshing, held], OFFLINE)).toBe('ready');
    expect(readState([stale], { online: false, restoring: true })).toBe('ready');
  });

  it('is loading while a missing read is on its way, with or without a network', () => {
    expect(readState([holds([1]), onItsWay], ONLINE)).toBe('loading');
    // A client that attempts its reads offline: not "offline" before it failed.
    expect(readState([onItsWay], OFFLINE)).toBe('loading');
    expect(readState([failed, onItsWay], ONLINE)).toBe('loading');
  });

  // No read holds data yet and none was sent: on a device without a network
  // that is exactly what "nothing kept" looks like, a moment too early.
  it('is loading while the cache is read back from the device', () => {
    expect(readState([notAsked], { online: false, restoring: true })).toBe('loading');
    expect(readState([waiting], { online: false, restoring: true })).toBe('loading');
    expect(readState([failed], { online: true, restoring: true })).toBe('loading');
  });

  it('is offline when a missing read waits for the network, or the device has none', () => {
    expect(readState([waiting], OFFLINE)).toBe('offline');
    // The client holds the read back before the device says it is offline.
    expect(readState([waiting], ONLINE)).toBe('offline');
    // The read was attempted and failed: the device being offline is why.
    expect(readState([failed], OFFLINE)).toBe('offline');
    expect(readState([holds([1]), notAsked], OFFLINE)).toBe('offline');
  });

  it('is failed when a missing read got no answer on a network', () => {
    expect(readState([failed], ONLINE)).toBe('failed');
    expect(readState([holds([1]), failed], ONLINE)).toBe('failed');
  });

  it('is loading for a read that was not asked yet: there is nothing to report', () => {
    expect(readState([notAsked], ONLINE)).toBe('loading');
  });

  it('is decided by the reads that hold nothing: one is enough', () => {
    expect(readState([holds([1]), holds([2]), waiting], ONLINE)).toBe('offline');
    expect(readState([holds(null)], ONLINE)).toBe('loading');
  });
});
