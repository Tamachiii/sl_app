// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, readRepoFile as read } from '../_test/harness.js';
import { PUSH_ENDPOINT_PATTERN, isPushEndpoint, pushHost } from './pushHosts.js';

// The list of push services a function sends to (review B3). It is one list
// in more than one place:
//
//   - here, asked by the functions before every send;
//   - in the database, as the check constraint
//     push_subscriptions_endpoint_known_push_service (migration
//     2026_10_13_15_push_plumbing, and schema.sql);
//   - in supabase/tests/fixtures/push-endpoints.json, the examples both
//     sides are held to.
//
// The last two come with the migration, which another lane writes: the two
// tests that read them are skipped in a checkout that does not have them
// yet, and hold from the day it does. The examples below stand on their own.

const ACCEPTED = [
  'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ',
  'https://fcm.googleapis.com/wp/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl0Zk3x8Qb2n5T',
  'https://web.push.apple.com/QGuQyavXutnMH9g6XgXc1wxrFWq0P2PA7B7nE',
  'https://api.sandbox.push.apple.com/3/device/0123456789abcdef',
  'https://wns2-by3p.notify.windows.com/w/?token=BQYAAAD%2bWsR8',
  'https://db5p.notify.windows.com/w/?token=AwYAAAB',
];

const REFUSED = {
  'not https': [
    'http://fcm.googleapis.com/fcm/send/abc',
    'wss://fcm.googleapis.com/fcm/send/abc',
    'ftp://web.push.apple.com/abc',
    '//fcm.googleapis.com/fcm/send/abc',
    'fcm.googleapis.com/fcm/send/abc',
    'javascript:fetch(\'https://fcm.googleapis.com/\')',
  ],
  'another host that only looks like one of the four': [
    'https://fcm.googleapis.com.example.org/fcm/send/abc',
    'https://notfcm.googleapis.com/fcm/send/abc',
    'https://googleapis.com/fcm/send/abc',
    'https://web.push.apple.com.example.org/abc',
    'https://wns2.notify.windows.com.example.org/w/?token=abc',
    'https://updates.push.services.mozilla.org/wpush/v2/abc',
  ],
  'the bare domain, where a host under it is asked for': [
    'https://push.apple.com/abc',
    'https://notify.windows.com/w/?token=abc',
  ],
  'one of the four names anywhere but in the host': [
    'https://example.org/fcm.googleapis.com/fcm/send/abc',
    'https://example.org/?to=https://fcm.googleapis.com/fcm/send/abc',
    'https://example.org/#https://web.push.apple.com/abc',
    'https://example.org/.push.apple.com/abc',
    'https://example.org/\nhttps://fcm.googleapis.com/fcm/send/abc',
  ],
  'a user name in front of the host': [
    'https://fcm.googleapis.com@example.org/fcm/send/abc',
    'https://user:secret@example.org/fcm.googleapis.com/',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://user:secret@web.push.apple.com/abc',
  ],
  'this machine, this network, this project': [
    'https://127.0.0.1/fcm/send/abc',
    'https://localhost/fcm/send/abc',
    'https://[::1]/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data/',
    'https://abcdefghijklmnopqrst.supabase.co/functions/v1/send-push',
  ],
  'no path': [
    'https://fcm.googleapis.com',
    'https://web.push.apple.com',
  ],
  'not written the way a browser hands it over': [
    'https://FCM.googleapis.com/fcm/send/abc',
    'HTTPS://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://Web.Push.Apple.com/abc',
    ' https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com\\fcm/send/abc',
  ],
  'not an address, not a text': [
    'not a url', '', null, undefined, 0, {}, ['https://fcm.googleapis.com/fcm/send/abc'],
    new URL('https://fcm.googleapis.com/fcm/send/abc'),
  ],
};

describe('isPushEndpoint: an address at one of the four push services, and nothing else', () => {
  it('accepts what the browsers hand over', () => {
    for (const endpoint of ACCEPTED) expect(isPushEndpoint(endpoint), endpoint).toBe(true);
  });

  for (const [why, endpoints] of Object.entries(REFUSED)) {
    it(`refuses ${why}`, () => {
      for (const endpoint of endpoints) expect(isPushEndpoint(endpoint), String(endpoint)).toBe(false);
    });
  }

  // The expression is the database's, on the text as it is. The HTTP client
  // that sends the push goes by what a URL parser reads: where the two could
  // disagree, the answer is no.
  it('agrees with a URL parser on the host of everything it accepts', () => {
    for (const endpoint of ACCEPTED) {
      const url = new URL(endpoint);
      expect(endpoint.startsWith(`https://${url.hostname}/`), endpoint).toBe(true);
      expect(`${url.username}${url.password}${url.port}`, endpoint).toBe('');
      expect(url.hostname).toMatch(/(^fcm\.googleapis\.com|^updates\.push\.services\.mozilla\.com|\.push\.apple\.com|\.notify\.windows\.com)$/);
    }
  });
});

describe('pushHost: what a log line may say of an endpoint', () => {
  it('gives the host and nothing of the path, the query, the port or a user name', () => {
    expect(pushHost('https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b')).toBe('fcm.googleapis.com');
    expect(pushHost('https://wns2-by3p.notify.windows.com/w/?token=BQYAAAD')).toBe('wns2-by3p.notify.windows.com');
    expect(pushHost('https://user:secret@attacker.example:8443/collect?token=abc#frag')).toBe('attacker.example');
    expect(pushHost('HTTPS://Web.Push.Apple.com/QGuQyav')).toBe('web.push.apple.com');
  });

  it('says not-a-url for anything else, and never throws', () => {
    for (const endpoint of ['not a url', '', 'fcm.googleapis.com/fcm/send/abc', 'mailto:', null, undefined, 42, {}]) {
      expect(pushHost(endpoint), String(endpoint)).toBe('not-a-url');
    }
  });
});

// ------------------------------------------------------------
// The same list as the database's.
// ------------------------------------------------------------
describe('the list is the one the database has', () => {
  const SCHEMA = 'supabase/schema.sql';
  const FIXTURE = 'supabase/tests/fixtures/push-endpoints.json';

  const schema = existsSync(resolve(REPO_ROOT, SCHEMA)) ? read(SCHEMA) : '';
  // CONSTRAINT <name> CHECK ( endpoint ~ '<expression>' )
  const [, inTheDatabase] = /CONSTRAINT\s+push_subscriptions_endpoint_known_push_service\s+CHECK\s*\(\s*endpoint\s*~\s*'([^']+)'/.exec(schema) ?? [];
  const examples = existsSync(resolve(REPO_ROOT, FIXTURE)) ? JSON.parse(read(FIXTURE)) : null;

  it('writes the expression without a quote, a back-slash or a flag, so that Postgres and JavaScript read it alike', () => {
    // [.] for a dot and no \d, \w or (?i): the two languages differ on those.
    expect(PUSH_ENDPOINT_PATTERN).not.toMatch(/['"\\]/);
    expect(PUSH_ENDPOINT_PATTERN).toMatch(/^\^https:\/\/\(.+\)\/$/);
    expect(PUSH_ENDPOINT_PATTERN).not.toContain('(?');
  });

  it.skipIf(!inTheDatabase)(`is, character for character, the check constraint of ${SCHEMA}`, () => {
    expect(PUSH_ENDPOINT_PATTERN).toBe(inTheDatabase);
  });

  it.skipIf(!examples)(`accepts and refuses the examples of ${FIXTURE}`, () => {
    expect(examples.accepted.length).toBeGreaterThan(3);
    expect(examples.refused.length).toBeGreaterThan(10);
    for (const endpoint of examples.accepted) expect(isPushEndpoint(endpoint), endpoint).toBe(true);
    for (const endpoint of examples.refused) expect(isPushEndpoint(endpoint), endpoint).toBe(false);
    // What the database refuses as written and a URL parser would read as one
    // of the four hosts: the function asks the database's expression first,
    // so it is never the laxer of the two.
    for (const endpoint of examples.refused_by_the_database_only) expect(isPushEndpoint(endpoint), endpoint).toBe(false);
  });
});
