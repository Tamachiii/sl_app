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

export const BUILD_META = 'sl-build';

/** What stands in for an id where no build made one (vite dev pages have one; vitest and plain scripts do not). */
export const NO_BUILD = 'dev';

const VALID_ID = /^[\w.-]{1,64}$/;

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

/** Run time. The id written in a document, or NO_BUILD. */
export function readBuildId(doc = typeof document !== 'undefined' ? document : null) {
  const meta = doc ? doc.querySelector(`meta[name="${BUILD_META}"]`) : null;
  const id = meta ? (meta.getAttribute('content') || '').trim() : '';
  return id || NO_BUILD;
}

/** The build of the page that is running. */
export const BUILD_ID = readBuildId();
