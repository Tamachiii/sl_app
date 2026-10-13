import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BUILD_ID,
  BUILD_META,
  MIN_BUILD_ENV,
  NO_BUILD,
  VERSION_FILE,
  buildInfoPlugin,
  buildMetaTag,
  fetchVersion,
  isBelowMinimum,
  makeBuildId,
  makeVersion,
  parseVersion,
  readBuildId,
} from './buildInfo';

function documentWith(head) {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, 'text/html');
}

describe('makeBuildId — the id a build gives itself', () => {
  it('is the UTC time the build started, to the second', () => {
    expect(makeBuildId({ now: new Date('2026-10-13T14:23:55.678Z') })).toBe('20261013142355');
    expect(makeBuildId({ env: { SL_BUILD_ID: '   ' }, now: new Date('2026-01-02T03:04:05Z') })).toBe(
      '20260102030405',
    );
  });

  it('sorts, as a string, in the order of the builds', () => {
    const times = [
      '2026-10-13T23:59:59Z',
      '2026-10-14T00:00:00Z',
      '2026-11-01T09:00:00Z',
      '2027-01-01T00:00:00Z',
    ];
    const ids = times.map((t) => makeBuildId({ now: new Date(t) }));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids.map((id) => id.length))).toEqual(new Set([14]));
  });

  it('is the one the environment gives, when it gives one', () => {
    expect(makeBuildId({ env: { SL_BUILD_ID: ' 20261013142355-r7 ' } })).toBe('20261013142355-r7');
  });

  it('refuses an id that could not be written into a tag or a file name', () => {
    expect(() => makeBuildId({ env: { SL_BUILD_ID: '"><script>' } })).toThrow(/SL_BUILD_ID/);
    expect(() => makeBuildId({ env: { SL_BUILD_ID: 'a b' } })).toThrow(/SL_BUILD_ID/);
    expect(() => makeBuildId({ env: { SL_BUILD_ID: 'x'.repeat(65) } })).toThrow(/SL_BUILD_ID/);
  });
});

describe('the id in index.html', () => {
  it('is written as a meta tag in the head', () => {
    expect(buildMetaTag('20261013142355')).toEqual({
      tag: 'meta',
      attrs: { name: BUILD_META, content: '20261013142355' },
      injectTo: 'head',
    });
  });

  it('is read back by the page', () => {
    const tag = buildMetaTag('20261013142355');
    const doc = documentWith(`<meta name="${tag.attrs.name}" content="${tag.attrs.content}">`);
    expect(readBuildId(doc)).toBe('20261013142355');
  });

  it('is NO_BUILD for a page no build wrote, or where there is no page', () => {
    expect(readBuildId(documentWith(''))).toBe(NO_BUILD);
    expect(readBuildId(documentWith(`<meta name="${BUILD_META}" content="  ">`))).toBe(NO_BUILD);
    expect(readBuildId(null)).toBe(NO_BUILD);
    expect(BUILD_ID).toBe(NO_BUILD); // vitest's document has no build
  });
});

describe('makeVersion — what version.json says for a build', () => {
  const build = '20261013142355';

  it('names the build, and no minimum when the environment gives none', () => {
    expect(makeVersion({ build })).toEqual({ build, minBuild: null });
    expect(makeVersion({ build, env: {} })).toEqual({ build, minBuild: null });
    expect(makeVersion({ build, env: { [MIN_BUILD_ENV]: '  ' } })).toEqual({ build, minBuild: null });
    expect(MIN_BUILD_ENV).toBe('MIN_CLIENT_BUILD');
  });

  it('takes the minimum the environment gives: the id of a build, or a time before this one', () => {
    expect(makeVersion({ build, env: { MIN_CLIENT_BUILD: ' 20261012090000 ' } })).toEqual({
      build,
      minBuild: '20261012090000',
    });
    // The build itself may be the minimum: everything before it must update.
    expect(makeVersion({ build, env: { MIN_CLIENT_BUILD: build } }).minBuild).toBe(build);
  });

  it('refuses a minimum later than the build, which no device could ever reach', () => {
    expect(() => makeVersion({ build, env: { MIN_CLIENT_BUILD: '20261013142356' } })).toThrow(
      /MIN_CLIENT_BUILD \(20261013142356\) is later than this build \(20261013142355\)/,
    );
  });

  it('refuses a minimum that is not the time of a build, 14 digits', () => {
    for (const typed of [
      '2026-10-13 14:23',
      // Would pass for an id — and sort BEFORE every build of the year: a minimum that does nothing.
      '2026-10-13',
      '20261013', // a day: which end of it?
      '202610131423550', // one digit too many
      'true', // the value of the other variable of the deploy, typed into this one
      '"}',
    ]) {
      expect(() => makeVersion({ build, env: { MIN_CLIENT_BUILD: typed } }), typed).toThrow(
        /MIN_CLIENT_BUILD must be the id of a build: its UTC time, 14 digits/,
      );
    }
  });
});

describe('the plugin of the build: one id, in index.html and in version.json', () => {
  const now = new Date('2026-10-13T14:23:55Z');

  /** Run the hooks a build runs, and return what was written. */
  function built(plugin) {
    const emitted = [];
    plugin.configResolved({ command: 'build' });
    plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) });
    return { tags: plugin.transformIndexHtml(), emitted };
  }

  it('writes the same id into both', () => {
    const { tags, emitted } = built(buildInfoPlugin({ now }));

    expect(tags).toEqual([buildMetaTag('20261013142355')]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'asset', fileName: VERSION_FILE });
    expect(VERSION_FILE).toBe('version.json');
    expect(JSON.parse(emitted[0].source)).toEqual({ build: '20261013142355', minBuild: null });
    // …and what it writes is what the page reads back.
    expect(parseVersion(JSON.parse(emitted[0].source))).toEqual({ build: '20261013142355', minBuild: null });
  });

  it('writes the minimum of the environment, and the id the environment gives', () => {
    const env = { SL_BUILD_ID: '20261013142355-r7', MIN_CLIENT_BUILD: '20261001000000' };
    const { tags, emitted } = built(buildInfoPlugin({ env, now }));

    expect(tags[0].attrs.content).toBe('20261013142355-r7');
    expect(JSON.parse(emitted[0].source)).toEqual({ build: '20261013142355-r7', minBuild: '20261001000000' });
  });

  it('stops a build whose minimum cannot be published, before anything is built', () => {
    const plugin = buildInfoPlugin({ env: { MIN_CLIENT_BUILD: '20270101000000' }, now });
    expect(() => plugin.configResolved({ command: 'build' })).toThrow(/MIN_CLIENT_BUILD/);
  });

  it('leaves the dev server and the tests alone, whatever the environment holds', () => {
    const plugin = buildInfoPlugin({ env: { MIN_CLIENT_BUILD: '20270101000000' }, now });
    expect(() => plugin.configResolved({ command: 'serve' })).not.toThrow();
    expect(plugin.transformIndexHtml()).toEqual([buildMetaTag('20261013142355')]);
  });

  it('is the plugin vite.config.js loads, under the name the docs give it', () => {
    expect(buildInfoPlugin({ now }).name).toBe('sl-build-id');
  });
});

describe('parseVersion — version.json as it was read', () => {
  it('is the build and the minimum', () => {
    expect(parseVersion({ build: '20261013142355', minBuild: '20261012090000' })).toEqual({
      build: '20261013142355',
      minBuild: '20261012090000',
    });
  });

  it('has no minimum when the file names none', () => {
    expect(parseVersion({ build: '20261013142355', minBuild: null })).toEqual({ build: '20261013142355', minBuild: null });
    expect(parseVersion({ build: '20261013142355' })).toEqual({ build: '20261013142355', minBuild: null });
    // Fields a later build may add are not this one's business.
    expect(parseVersion({ build: '20261013142355', minBuild: null, notes: 'x' })).toEqual({
      build: '20261013142355',
      minBuild: null,
    });
  });

  it('is null for anything that is not the file', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion('20261013142355')).toBeNull();
    expect(parseVersion([])).toBeNull();
    expect(parseVersion({})).toBeNull();
    expect(parseVersion({ build: 20261013142355 })).toBeNull();
    expect(parseVersion({ build: '<html>' })).toBeNull();
    expect(parseVersion({ build: '20261013142355', minBuild: 20261012090000 })).toBeNull();
    expect(parseVersion({ build: '20261013142355', minBuild: '' })).toBeNull();
    expect(parseVersion({ build: '20261013142355', minBuild: 'not an id' })).toBeNull();
  });
});

describe('isBelowMinimum — must this build update?', () => {
  const version = { build: '20261013142355', minBuild: '20261012090000' };

  it('yes for a build older than the minimum', () => {
    expect(isBelowMinimum('20261012085959', version)).toBe(true);
    expect(isBelowMinimum('20260930120000', version)).toBe(true);
  });

  it('no for the minimum itself, and for anything after it', () => {
    expect(isBelowMinimum('20261012090000', version)).toBe(false);
    expect(isBelowMinimum('20261013142355', version)).toBe(false);
    expect(isBelowMinimum('20270101000000', version)).toBe(false);
  });

  it('never for a page no build made', () => {
    expect(isBelowMinimum(NO_BUILD, version)).toBe(false);
    expect(isBelowMinimum('', version)).toBe(false);
    expect(isBelowMinimum(undefined, version)).toBe(false);
  });

  it('never without a version that names a minimum', () => {
    expect(isBelowMinimum('20260930120000', null)).toBe(false);
    expect(isBelowMinimum('20260930120000', { build: '20261013142355', minBuild: null })).toBe(false);
    expect(isBelowMinimum('20260930120000', parseVersion({ build: '20261013142355', minBuild: 'not an id' }))).toBe(false);
  });
});

describe('fetchVersion — version.json as the server has it now', () => {
  const body = { build: '20261013142355', minBuild: '20261012090000' };
  const answer = (value, ok = true) => ({ ok, json: async () => value });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('asks for the file next to index.html, and never takes it from a cache', async () => {
    vi.stubEnv('BASE_URL', '/sl_app/'); // `base` of vite.config.js; vitest serves from '/'
    const fetch = vi.fn(async () => answer(body));

    await expect(fetchVersion({ fetch })).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/sl_app/version.json', { cache: 'no-store' });
  });

  it('asks with the fetch of the page when it is given none', async () => {
    const fetch = vi.fn(async () => answer(body));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(fetchVersion({ baseUrl: '/sl_app/' })).resolves.toEqual(body);
      expect(fetch).toHaveBeenCalledWith('/sl_app/version.json', { cache: 'no-store' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes the place it is told', async () => {
    const fetch = vi.fn(async () => answer(body));
    await fetchVersion({ fetch, baseUrl: '/elsewhere/' });
    expect(fetch).toHaveBeenCalledWith('/elsewhere/version.json', { cache: 'no-store' });
  });

  it('is null when the file is not there', async () => {
    const fetch = vi.fn(async () => answer({ message: 'Not Found' }, false));
    await expect(fetchVersion({ fetch, baseUrl: '/' })).resolves.toBeNull();
  });

  it('is null when the host answers with a page instead of the file', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
      },
    }));
    await expect(fetchVersion({ fetch, baseUrl: '/' })).resolves.toBeNull();
  });

  it('is null when the file is not a version', async () => {
    const fetch = vi.fn(async () => answer({ name: 'Street Lifting Coach' }));
    await expect(fetchVersion({ fetch, baseUrl: '/' })).resolves.toBeNull();
  });

  it('is null without a network, and never throws', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchVersion({ fetch, baseUrl: '/' })).resolves.toBeNull();
  });
});
