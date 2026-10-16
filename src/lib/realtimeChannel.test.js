import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { realtime } = await vi.hoisted(async () => {
  const { createFakeRealtime } = await import('../test/fakeRealtime');
  return { realtime: createFakeRealtime() };
});
vi.mock('./supabase', () => ({ supabase: realtime }));

import { goOnline, setVisibility } from '../test/fakeRealtime';
import {
  watchPostgresChanges,
  resyncRefetchOptions,
  MAX_JOIN_FAILURES,
  REOPEN_AFTER_MS,
  RESYNC,
  RESYNC_AFTER_HIDDEN_MS,
  RESYNC_GAP_MS,
} from './realtimeChannel';

const FILTERS = [{ event: '*', schema: 'public', table: 'messages' }];

let stops = [];
function watch(overrides = {}) {
  const onChange = vi.fn();
  const onResync = vi.fn();
  const stop = watchPostgresChanges({ topic: 'messages-me', filters: FILTERS, onChange, onResync, ...overrides });
  stops.push(stop);
  return { onChange, onResync, stop, channel: () => realtime.live().at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  realtime.reset();
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  setVisibility('visible');
  vi.useRealTimers();
});

describe('watchPostgresChanges — a channel that fails', () => {
  it('keeps the channel through CHANNEL_ERROR and TIMED_OUT, and resyncs when it is joined again', () => {
    const { onResync, channel } = watch();
    const ch = channel();
    ch.status('SUBSCRIBED');
    onResync.mockClear();

    ch.status('CHANNEL_ERROR');
    ch.status('TIMED_OUT');
    expect(realtime.removeChannel).not.toHaveBeenCalled();
    expect(realtime.live()).toEqual([ch]);
    expect(onResync).not.toHaveBeenCalled();

    // The client joins it again by itself: everything missed is read again.
    ch.status('SUBSCRIBED');
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(realtime.channel).toHaveBeenCalledTimes(1);
  });

  it('resyncs on the first SUBSCRIBED too: what the page read while joining arrived on no channel', () => {
    const { onResync, channel } = watch();
    expect(onResync).not.toHaveBeenCalled();
    channel().status('SUBSCRIBED');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('a SUBSCRIBED resets the count of failures', () => {
    const { channel } = watch();
    const ch = channel();
    for (let i = 0; i < MAX_JOIN_FAILURES - 1; i += 1) ch.status('CHANNEL_ERROR');
    ch.status('SUBSCRIBED');
    for (let i = 0; i < MAX_JOIN_FAILURES - 1; i += 1) ch.status('TIMED_OUT');
    expect(realtime.removeChannel).not.toHaveBeenCalled();
  });

  it(`lets the channel go after ${MAX_JOIN_FAILURES} failures in a row, and opens a new one on online with a fresh count`, () => {
    const { onResync, channel } = watch();
    const first = channel();
    for (let i = 0; i < MAX_JOIN_FAILURES - 1; i += 1) first.status('CHANNEL_ERROR');
    expect(realtime.removeChannel).not.toHaveBeenCalled();
    first.status('TIMED_OUT');
    expect(realtime.removeChannel).toHaveBeenCalledWith(first);
    expect(realtime.live()).toEqual([]);

    // Nothing reopens it by itself: a join refused every time is not retried forever.
    vi.advanceTimersByTime(10 * REOPEN_AFTER_MS);
    expect(realtime.live()).toEqual([]);

    goOnline();
    const second = channel();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(onResync).toHaveBeenCalledTimes(1);
    // A new count: seven failures do not let the new channel go.
    for (let i = 0; i < MAX_JOIN_FAILURES - 1; i += 1) second.status('CHANNEL_ERROR');
    expect(realtime.live()).toEqual([second]);
  });

  it('opens a channel that was let go again when the page becomes visible', () => {
    const { channel } = watch();
    const first = channel();
    for (let i = 0; i < MAX_JOIN_FAILURES; i += 1) first.status('CHANNEL_ERROR');
    expect(realtime.live()).toEqual([]);

    setVisibility('hidden');
    expect(realtime.live()).toEqual([]);
    setVisibility('visible');
    expect(realtime.live()).toHaveLength(1);
    expect(channel()).not.toBe(first);
  });
});

describe('watchPostgresChanges — a channel the server closes', () => {
  it('opens a channel that had lived REOPEN_AFTER_MS again at once', () => {
    const { channel } = watch();
    const first = channel();
    first.status('SUBSCRIBED');
    vi.advanceTimersByTime(REOPEN_AFTER_MS);
    first.status('CLOSED');
    const second = channel();
    expect(second).not.toBe(first);
    expect(realtime.channel).toHaveBeenCalledTimes(2);
  });

  it('waits until a younger channel is REOPEN_AFTER_MS old', () => {
    const { channel } = watch();
    const first = channel();
    first.status('SUBSCRIBED');
    vi.advanceTimersByTime(5_000);
    first.status('CLOSED');
    expect(realtime.channel).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REOPEN_AFTER_MS - 5_000 - 1);
    expect(realtime.channel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(realtime.channel).toHaveBeenCalledTimes(2);
  });

  it('opens a younger closed channel at once when the browser is back online, and only once', () => {
    const { channel } = watch();
    channel().status('CLOSED');
    goOnline();
    expect(realtime.channel).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REOPEN_AFTER_MS);
    expect(realtime.channel).toHaveBeenCalledTimes(2);
  });
});

describe('watchPostgresChanges — resync on return', () => {
  it('resyncs on online, and on visibilitychange to visible after a long absence, not on hidden', () => {
    const { onResync, channel } = watch();
    channel().status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(RESYNC_GAP_MS);

    goOnline();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.ONLINE);

    vi.advanceTimersByTime(RESYNC_GAP_MS);
    setVisibility('hidden');
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.VISIBLE);
  });

  it('reads nothing again when the page was hidden a short while and its channel stayed joined', () => {
    const { onResync, channel } = watch();
    const ch = channel();
    ch.status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(10_000);

    // A tab that is switched away from and back: its socket was handed every event.
    setVisibility('hidden');
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS - 1);
    setVisibility('visible');
    expect(onResync).not.toHaveBeenCalled();
    expect(realtime.live()).toEqual([ch]);
    expect(realtime.channel).toHaveBeenCalledTimes(1);
  });

  it('a short absence still reads again when the channel is not joined', () => {
    const { onResync, channel } = watch();
    const ch = channel();
    ch.status('SUBSCRIBED');
    vi.advanceTimersByTime(10_000);
    ch.status('CHANNEL_ERROR');
    onResync.mockClear();

    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.VISIBLE);
    // The client joins it again itself: the channel is not replaced.
    expect(realtime.live()).toEqual([ch]);
  });

  it('a short absence still reads again for a channel that is still joining, or that the server closed', () => {
    const { onResync, channel } = watch();
    vi.advanceTimersByTime(10_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(1);

    channel().status('SUBSCRIBED');
    vi.advanceTimersByTime(10_000);
    channel().status('CLOSED');
    onResync.mockClear();
    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('a visible page whose absence was not seen reads again', () => {
    const { onResync, channel } = watch();
    channel().status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(10_000);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('counts the absence of a page that was hidden when the channel opened from the opening', () => {
    setVisibility('hidden');
    const { onResync, channel } = watch();
    channel().status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(5_000);
    setVisibility('visible');
    expect(onResync).not.toHaveBeenCalled();

    setVisibility('hidden');
    const late = watch();
    late.channel().status('SUBSCRIBED');
    late.onResync.mockClear();
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    expect(late.onResync).toHaveBeenCalledTimes(1);
  });

  it('a visible that reads nothing leaves the gap alone: online right after still resyncs', () => {
    const { onResync, channel } = watch();
    channel().status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(10_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    setVisibility('visible');
    goOnline();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.ONLINE);
  });

  it('online resyncs however short the absence', () => {
    const { onResync, channel } = watch();
    channel().status('SUBSCRIBED');
    onResync.mockClear();
    vi.advanceTimersByTime(10_000);
    setVisibility('hidden');
    goOnline();
    vi.advanceTimersByTime(500);
    setVisibility('visible');
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.ONLINE);
  });

  it('asks once for online and visible arriving together', () => {
    const { onResync } = watch();
    setVisibility('visible');
    goOnline();
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RESYNC_GAP_MS);
    goOnline();
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('never holds back the resync of a SUBSCRIBED', () => {
    const { onResync, channel } = watch();
    goOnline();
    channel().status('SUBSCRIBED');
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(onResync).toHaveBeenLastCalledWith(RESYNC.SUBSCRIBED);
  });
});

describe('resyncRefetchOptions', () => {
  it('cancels and sends again a read in flight after SUBSCRIBED, and joins it after online and visible', () => {
    expect(resyncRefetchOptions(RESYNC.SUBSCRIBED)).toEqual({ cancelRefetch: true });
    expect(resyncRefetchOptions(RESYNC.ONLINE)).toEqual({ cancelRefetch: false });
    expect(resyncRefetchOptions(RESYNC.VISIBLE)).toEqual({ cancelRefetch: false });
  });

  it('treats a resync that gives no reason as a SUBSCRIBED', () => {
    expect(resyncRefetchOptions()).toEqual({ cancelRefetch: true });
  });
});

describe('watchPostgresChanges — events and ending', () => {
  it('opens one binding per filter and hands their events over', () => {
    const filters = [
      { event: '*', schema: 'public', table: 'messages', filter: 'recipient_id=eq.me' },
      { event: '*', schema: 'public', table: 'messages', filter: 'sender_id=eq.me' },
    ];
    const { onChange, channel } = watch({ filters });
    expect(channel().bindings.map((b) => b.filter)).toEqual(filters);
    channel().emit('INSERT', { id: 'm1', sender_id: 'other', recipient_id: 'me' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].new).toEqual({ id: 'm1', sender_id: 'other', recipient_id: 'me' });
  });

  it('never gives two openings the same topic', () => {
    watch();
    watch();
    const [a, b] = realtime.channel.mock.calls.map(([name]) => name);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^messages-me-/);
    expect(realtime.live()).toHaveLength(2);
  });

  it('ignores the events and the statuses of a channel it let go', () => {
    const { onChange, onResync, channel } = watch();
    const first = channel();
    for (let i = 0; i < MAX_JOIN_FAILURES; i += 1) first.status('CHANNEL_ERROR');
    goOnline();
    onResync.mockClear();

    first.emit('INSERT', { id: 'm1' });
    first.status('SUBSCRIBED');
    expect(onChange).not.toHaveBeenCalled();
    expect(onResync).not.toHaveBeenCalled();
  });

  it('stop removes the channel and both listeners, and nothing reopens it', () => {
    const { onChange, onResync, stop, channel } = watch();
    const ch = channel();
    stop();
    expect(realtime.removeChannel).toHaveBeenCalledWith(ch);
    expect(realtime.live()).toEqual([]);

    goOnline();
    setVisibility('visible');
    vi.advanceTimersByTime(10 * REOPEN_AFTER_MS);
    ch.emit('INSERT', { id: 'm1' });
    expect(realtime.channel).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onResync).not.toHaveBeenCalled();
  });

  it('stop cancels a reopening that was waiting', () => {
    const { stop, channel } = watch();
    channel().status('CLOSED');
    stop();
    vi.advanceTimersByTime(REOPEN_AFTER_MS);
    expect(realtime.channel).toHaveBeenCalledTimes(1);
    expect(realtime.live()).toEqual([]);
  });
});
