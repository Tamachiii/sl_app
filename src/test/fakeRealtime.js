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
//   not what a filter on another column can be asked about;
// - a join carries the token the client holds when `subscribe()` is called
//   (`realtime.accessTokenValue`), and a channel joined without one is handed
//   no event: the server answers its join with ok — the status is SUBSCRIBED —
//   and refuses its postgres_changes, since `anon` reads no table. A token
//   that `realtime.setAuth()` changes reaches the channels that are joined,
//   as the client's `access_token` push does, and none whose join is on its
//   way. `launchBeforeSession()` starts the client with no token, as a page
//   drawn before auth-js has read the stored session does; `readSession()` is
//   auth-js answering.
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

/** The token of the signed-in user, once supabase-js has read the session. */
export const USER_TOKEN = 'user-jwt';

function createChannel(name, client) {
  const channel = {
    name,
    bindings: [],
    onStatus: null,
    removed: false,
    // The token of the join the server answered, and whether it is joined now.
    token: null,
    joined: false,
    joinedOnce: false,
    on(type, filter, callback) {
      if (channel.onStatus) {
        throw new Error(`cannot add \`${type}\` callbacks for ${name} after \`subscribe()\`.`);
      }
      channel.bindings.push({ type, filter, callback });
      return channel;
    },
    subscribe(callback) {
      channel.onStatus = callback;
      channel.token = client.accessTokenValue;
      return channel;
    },
    /**
     * What the client reports: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED.
     * A closed channel is gone from the client, as when the server closes it.
     * A SUBSCRIBED after an error is a join of its own, with the token the
     * client holds then.
     */
    status(value) {
      if (value === 'CLOSED') channel.removed = true;
      if (value === 'SUBSCRIBED' && channel.joinedOnce && !channel.joined) {
        channel.token = client.accessTokenValue;
      }
      channel.joined = value === 'SUBSCRIBED';
      if (channel.joined) channel.joinedOnce = true;
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
      if (!channel.token) return 0;
      const reached = channel.bindings.filter((binding) => matches(binding, payload));
      for (const binding of reached) binding.callback(payload);
      return reached.length;
    },
  };
  return channel;
}

export function createFakeRealtime() {
  const channels = [];
  // auth-js reading the stored session, while a launch waits for it.
  let session = null;

  function holdToken(value) {
    if (client.accessTokenValue === value) return;
    client.accessTokenValue = value;
    for (const channel of channels) {
      if (!channel.removed && channel.joined) channel.token = value;
    }
  }

  // The RealtimeClient: the token it holds, and setAuth — with a token, the
  // one supabase-js hands over on SIGNED_IN and TOKEN_REFRESHED; without, the
  // session's, which supabase-js reads through auth.getSession().
  const client = {
    accessTokenValue: USER_TOKEN,
    setAuth: vi.fn((token = null) => {
      if (token) {
        holdToken(token);
        return Promise.resolve();
      }
      return (session ? session.promise : Promise.resolve(USER_TOKEN)).then(holdToken);
    }),
  };

  const fake = {
    realtime: client,
    /** Every channel ever opened, removed ones included. */
    channels,
    channel: vi.fn((name) => {
      const registered = channels.find((c) => c.name === name && !c.removed);
      if (registered) return registered;
      const created = createChannel(name, client);
      channels.push(created);
      return created;
    }),
    removeChannel: vi.fn((channel) => {
      if (!channel.removed) channel.status('CLOSED');
      return Promise.resolve('ok');
    }),
    /** The channels that are open now. */
    live: () => channels.filter((c) => !c.removed),
    /** The client holds no token until `readSession()`. */
    launchBeforeSession() {
      client.accessTokenValue = null;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      session = { promise, resolve };
    },
    /**
     * auth-js has read the session: supabase-js hands its token to the
     * client (SIGNED_IN), and a setAuth() that waits gets it too. Settles
     * once what waited on that setAuth() has run as well.
     */
    async readSession(token = USER_TOKEN) {
      const waiting = session;
      session = null;
      await client.setAuth(token);
      waiting?.resolve(token);
      for (let turn = 0; turn < 10; turn += 1) await null;
    },
    reset() {
      channels.length = 0;
      session = null;
      client.accessTokenValue = USER_TOKEN;
      client.setAuth.mockClear();
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
