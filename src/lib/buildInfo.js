// The id of a build: how one is made (vite.config.js, at build time) and how
// the running page reads its own (BUILD_ID).
//
// The id travels in index.html — <meta name="sl-build" content="…"> — and not
// in a JavaScript bundle. A value that changes with every build, inlined into
// the entry chunk, changes that chunk's file name, and with it the content and
// the name of every chunk that imports it: a deploy that changed no source
// would then be a full download for every device. index.html changes with
// every build anyway.
//
// It is also readable from outside: the <head> of the published index.html
// says which build is live.
//
// The same build also writes version.json next to index.html:
//
//   { "build": "<its id>", "minBuild": "<an id>" | null }
//
// `minBuild` is the oldest build still allowed to run: a page whose own id is
// below it applies the update as soon as nothing would be lost, instead of
// offering it (lib/appUpdate). It comes from MIN_CLIENT_BUILD in the
// environment of the build — a repository variable of the deploy — and is
// null without it. The file is read from the network and never from the
// service worker's precache, whose list has no `.json` (vite.config.js).
//
// This module is imported by vite.config.js, under Node: nothing at its top
// level may need a browser, and `import.meta.env` is read inside functions
// only.

export const BUILD_META = 'sl-build';

/** The file, next to index.html, that says which build is published and which is the oldest allowed. */
export const VERSION_FILE = 'version.json';

/** The environment variable of the build that sets `minBuild`. */
export const MIN_BUILD_ENV = 'MIN_CLIENT_BUILD';

/** What stands in for an id where no build made one (vite dev pages have one; vitest and plain scripts do not). */
export const NO_BUILD = 'dev';

const VALID_ID = /^[\w.-]{1,64}$/;
// A minimum is typed by a person: one format, the one an id has when no
// SL_BUILD_ID replaced it. "2026-10-20" would be an id, and would compare as
// smaller than every build of the year — a minimum that does nothing, silently.
const A_TIME = /^\d{14}$/;

/**
 * Build time. The id of the build that starts now: the UTC time as
 * `YYYYMMDDHHmmss`, so that ids compared as strings sort in the order of the
 * builds. `SL_BUILD_ID` in the environment replaces it — it must sort the same
 * way — for a deploy that publishes the id somewhere else as well.
 */
export function makeBuildId({ env = {}, now = new Date() } = {}) {
  const given = String(env.SL_BUILD_ID ?? '').trim();
  if (given === '') return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  if (!VALID_ID.test(given)) {
    throw new Error(
      `SL_BUILD_ID must be 1 to 64 letters, digits, "_", "." or "-"; got "${given}"`,
    );
  }
  return given;
}

/** Build time. The tag a Vite `transformIndexHtml` hook returns to carry the id. */
export function buildMetaTag(id) {
  return { tag: 'meta', attrs: { name: BUILD_META, content: id }, injectTo: 'head' };
}

/**
 * Build time. What version.json says for the build `build`. The minimum is
 * refused when it is not the time of a build, and when it is later than the
 * build itself: the page of this very build would then be told, for ever, to
 * update to a version that does not exist.
 */
export function makeVersion({ build, env = {} }) {
  const min = String(env[MIN_BUILD_ENV] ?? '').trim();
  if (min === '') return { build, minBuild: null };
  if (!A_TIME.test(min)) {
    throw new Error(
      `${MIN_BUILD_ENV} must be the id of a build: its UTC time, 14 digits (YYYYMMDDHHmmss); got "${min}"`,
    );
  }
  if (min > build) {
    throw new Error(
      `${MIN_BUILD_ENV} (${min}) is later than this build (${build}): every device would be told to `
        + 'update to a version that does not exist. It is the oldest build still allowed to run — '
        + 'at most the UTC time of now, as YYYYMMDDHHmmss.',
    );
  }
  return { build, minBuild: min };
}

/**
 * Build time. The Vite plugin of the id: one id per build, written into
 * index.html as the meta tag and into version.json — the two can only agree.
 * A dev server gets the tag and no file.
 */
export function buildInfoPlugin({ env = {}, now } = {}) {
  const id = makeBuildId({ env, now });
  let version = null;
  return {
    name: 'sl-build-id',
    // A minimum that cannot be published stops the build before it starts —
    // and only a build: vitest and the dev server load this config too.
    configResolved(config) {
      if (config.command === 'build') version = makeVersion({ build: id, env });
    },
    transformIndexHtml: () => [buildMetaTag(id)],
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: VERSION_FILE,
        source: `${JSON.stringify(version ?? makeVersion({ build: id, env }))}\n`,
      });
    },
  };
}

/**
 * version.json as it was read, or null when it is not one: another shape, an
 * id that could not be one. `minBuild` is null when the file names none.
 */
export function parseVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { build, minBuild = null } = value;
  if (typeof build !== 'string' || !VALID_ID.test(build)) return null;
  if (minBuild !== null && (typeof minBuild !== 'string' || !VALID_ID.test(minBuild))) return null;
  return { build, minBuild };
}

/**
 * Is the build `buildId` older than the oldest one `version` allows? Never
 * for a page no build made, and never without a version that names a minimum.
 */
export function isBelowMinimum(buildId, version) {
  if (!version || !version.minBuild) return false;
  if (!buildId || buildId === NO_BUILD) return false;
  return buildId < version.minBuild;
}

/**
 * Run time. version.json as the server has it now — not as a cache remembers
 * it — or null: offline, not found, or an answer that is not the file (a host
 * that serves its "not found" page for it).
 */
export async function fetchVersion({
  fetch: request = (...args) => globalThis.fetch(...args),
  baseUrl = import.meta.env.BASE_URL,
} = {}) {
  try {
    // `no-store`: past the browser's own cache, in which the host lets the
    // file live for minutes.
    const response = await request(`${baseUrl}${VERSION_FILE}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return parseVersion(await response.json());
  } catch {
    return null;
  }
}

/** Run time. The id written in a document, or NO_BUILD. */
export function readBuildId(doc = typeof document !== 'undefined' ? document : null) {
  const meta = doc ? doc.querySelector(`meta[name="${BUILD_META}"]`) : null;
  const id = meta ? (meta.getAttribute('content') || '').trim() : '';
  return id || NO_BUILD;
}

/** The build of the page that is running. */
export const BUILD_ID = readBuildId();
