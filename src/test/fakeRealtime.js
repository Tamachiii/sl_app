import { vi } from 'vitest';

// A stand-in for the two Realtime entry points of the supabase client,
// `channel()` and `removeChannel()`. It keeps what the real client keeps and
// refuses what the real client refuses, so a test fails on the mistakes the
// real one punishes:
//
// - `channel(name)` hands back the channel that is still registered under that
//   name instead of a new one (realtime-js RealtimeClient.channel);
// - `on('postgres_changes', …)` throws once the channel is subscribed;
// - a removed channel reports CLOSED to its own subscribe callback, and a
//   channel that reports CLOSED is gone: `channel(name)` makes a new one;
// - an event is delivered to the bindings whose event and filter match it, the
//   way the server picks them. A DELETE goes to every binding that listens to
//   deletes: the row is gone, and what is left of it — its primary key — is
//   not what a filter on another column can be asked about.
//
// Usage, because `vi.mock` is hoisted above the imports:
//
//   const { realtime } = await vi.hoisted(async () => {
//     const { createFakeRealtime } = await import('../test/fakeRealtime');
//     return { realtime: createFakeRealtime() };
//   });
//   vi.mock('../lib/supabase', () => ({ supabase: realtime }));

function matches(binding, payload) {
  const { event, table, filter } = binding.filter;
  if (table && payload.table && table !== payload.table) return false;
  if (event !== '*' && event !== payload.eventType) return false;
  if (!filter || payload.eventType === 'DELETE') return true;
  const [column, rest = ''] = filter.split('=');
  const [operator, ...value] = rest.split('.');
  if (operator !== 'eq') throw new Error(`fakeRealtime: unsupported filter "${filter}"`);
  return String(payload.new?.[column]) === value.join('.');
}

function createChannel(name) {
  const channel = {
    name,
    bindings: [],
    onStatus: null,
    removed: false,
    on(type, filter, callback) {
      if (channel.onStatus) {
        throw new Error(`cannot add \`${type}\` callbacks for ${name} after \`subscribe()\`.`);
      }
      channel.bindings.push({ type, filter, callback });
      return channel;
    },
    subscribe(callback) {
      channel.onStatus = callback;
      return channel;
    },
    /**
     * What the client reports: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED.
     * A closed channel is gone from the client, as when the server closes it.
     */
    status(value) {
      if (value === 'CLOSED') channel.removed = true;
      channel.onStatus?.(value);
    },
    /** One change, shaped as the client hands it over. Returns how many bindings got it. */
    emit(eventType, row, table = channel.bindings[0]?.filter.table) {
      const payload = {
        schema: 'public',
        table,
        commit_timestamp: '2026-10-13T12:00:00.000Z',
        eventType,
        // Under row-level security the old record is the primary key and
        // nothing else, and a DELETE carries an empty `new`.
        new: eventType === 'DELETE' ? {} : row,
        old: eventType === 'INSERT' ? {} : { id: row.id },
        errors: null,
      };
      const reached = channel.bindings.filter((binding) => matches(binding, payload));
      for (const binding of reached) binding.callback(payload);
      return reached.length;
    },
  };
  return channel;
}

export function createFakeRealtime() {
  const channels = [];
  const fake = {
    /** Every channel ever opened, removed ones included. */
    channels,
    channel: vi.fn((name) => {
      const registered = channels.find((c) => c.name === name && !c.removed);
      if (registered) return registered;
      const created = createChannel(name);
      channels.push(created);
      return created;
    }),
    removeChannel: vi.fn((channel) => {
      if (!channel.removed) channel.status('CLOSED');
      return Promise.resolve('ok');
    }),
    /** The channels that are open now. */
    live: () => channels.filter((c) => !c.removed),
    reset() {
      channels.length = 0;
      fake.channel.mockClear();
      fake.removeChannel.mockClear();
    },
  };
  return fake;
}

/** Fires the two browser signals a returning page gives. */
export function goOnline() {
  window.dispatchEvent(new Event('online'));
}

export function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
