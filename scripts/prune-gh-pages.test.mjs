// @vitest-environment node
import {
  afterAll, describe, expect, it,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADOPTED_BUILD, ASSETS_DIR, BUILDS_DIR, KEEP_BUILDS, PAGE, SiteError,
  applyPlan, assetPathFault, planSite, readDist, readSite, render,
} from './lib/published-builds.mjs';
import { BUILD_META, VERSION_FILE, buildInfoPlugin } from '../src/lib/buildInfo.js';

// What a deploy keeps of the builds before it (second half of review finding
// P65). A page that was opened before a deploy asks for the files of ITS build
// when a screen is opened for the first time; what is held here is that the
// files of the last three builds are there to be found, that nothing else of
// the published tree is ever deleted, and that a tree the script does not
// understand is left exactly as it was.
//
// No git and no network: the published tree is a folder, as the workflow hands
// it over (src/test/ciGuardrails.test.js runs that step against a repository).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND = path.join(root, 'scripts/prune-gh-pages.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-published-builds-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const folder = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));

/** Write `files` ({ 'a/b.js': 'text' }) under `dir`. */
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/** Every file under `dir`, as { 'a/b.js': 'text' }; a link as where it points. */
function tree(dir, at = '') {
  const out = {};
  for (const entry of fs.readdirSync(path.join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(path.join(dir, rel))}`;
    else if (entry.isDirectory()) Object.assign(out, tree(dir, rel));
    else out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
  }
  return out;
}

const names = (dir) => Object.keys(tree(dir)).sort();

/**
 * What `npm run build` leaves for the build `id`: the page with its id, the
 * worker, version.json — written by the plugin of the real build — and the
 * files `assets` names, each holding its own name.
 */
function dist(id, assets, { minBuild } = {}) {
  const plugin = buildInfoPlugin({ env: { SL_BUILD_ID: id, ...(minBuild ? { MIN_CLIENT_BUILD: minBuild } : {}) } });
  const [tag] = plugin.transformIndexHtml();
  const emitted = [];
  plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) });
  return write(folder('dist'), {
    'index.html': `<!doctype html><html><head><meta name="${tag.attrs.name}" content="${tag.attrs.content}"></head><body>${id}</body></html>`,
    'sw.js': `// worker of ${id}`,
    'manifest.webmanifest': '{}',
    'favicon.svg': '<svg/>',
    [emitted[0].fileName]: emitted[0].source,
    ...Object.fromEntries(assets.map((name) => [`${ASSETS_DIR}/${name}`, name])),
  });
}

const run = (args, env = {}) => spawnSync(process.execPath, [COMMAND, ...args], {
  env: { PATH: process.env.PATH, ...env },
  encoding: 'utf8',
});

/** One deploy: the command, as the workflow runs it. */
const deploy = (site, built, extra = [], env = {}) => run(['--site', site, '--dist', built, ...extra], env);

const record = (build, files) => `${JSON.stringify({ build, files: files.map((name) => `${ASSETS_DIR}/${name}`) })}\n`;
const recordOf = (site, build) => JSON.parse(fs.readFileSync(path.join(site, BUILDS_DIR, `${build}.json`), 'utf8'));
const assetsOf = (site) => (fs.existsSync(path.join(site, ASSETS_DIR)) ? fs.readdirSync(path.join(site, ASSETS_DIR)).sort() : []);

// Four builds. `vendor` never changes; each build has an entry of its own.
const B1 = '20261010080000';
const B2 = '20261011080000';
const B3 = '20261012080000';
const B4 = '20261013080000';
const VENDOR = 'vendor-v1.js';

// ------------------------------------------------------------
// The site as it is today: published by the deploy that replaced everything
// ------------------------------------------------------------
/** The tree of the client that is live: no records, its own files, and one file somebody added by hand. */
function liveSite() {
  return write(folder('site'), {
    'index.html': '<!doctype html><html><head></head><body>live</body></html>',
    'sw.js': '// worker of the live client',
    'google1234567890abcdef.html': 'google-site-verification: google1234567890abcdef.html',
    '.nojekyll': '',
    'manifest.webmanifest': '{}',
    [`${ASSETS_DIR}/index-live.js`]: 'index-live.js',
    [`${ASSETS_DIR}/SessionView-live.js`]: 'SessionView-live.js',
    [`${ASSETS_DIR}/${VENDOR}`]: VENDOR,
  });
}

describe('the first deploy on top of a site that was published without records', () => {
  const site = liveSite();
  const done = deploy(site, dist(B1, ['index-b1.js', VENDOR]));

  it('keeps every file the live client asks for', () => {
    expect(done.status, done.stderr).toBe(0);
    expect(assetsOf(site)).toEqual(['SessionView-live.js', 'index-b1.js', 'index-live.js', VENDOR].sort());
  });

  it('adopts them as one build, older than every other', () => {
    expect(recordOf(site, ADOPTED_BUILD)).toEqual({
      build: ADOPTED_BUILD,
      files: ['SessionView-live.js', 'index-live.js', VENDOR].map((name) => `${ASSETS_DIR}/${name}`).sort(),
    });
    expect(ADOPTED_BUILD < B1).toBe(true);
    expect(done.stdout).toContain('adopted    the 3 files that were published without a record');
  });

  it('publishes the new build: its page, its worker, its version, its record', () => {
    const now = tree(site);
    expect(now['index.html']).toContain(`content="${B1}"`);
    expect(now['sw.js']).toBe(`// worker of ${B1}`);
    expect(JSON.parse(now[VERSION_FILE])).toEqual({ build: B1, minBuild: null });
    expect(recordOf(site, B1)).toEqual({ build: B1, files: [`${ASSETS_DIR}/index-b1.js`, `${ASSETS_DIR}/${VENDOR}`] });
  });

  it('leaves alone what no build writes', () => {
    const now = tree(site);
    expect(now['google1234567890abcdef.html']).toBe('google-site-verification: google1234567890abcdef.html');
    expect(now['.nojekyll']).toBe('');
  });

  it('keeps the live client\'s files through the next deploy, and lets them go with the one after', () => {
    expect(deploy(site, dist(B2, ['index-b2.js', VENDOR])).status).toBe(0);
    // Three builds published: the adopted one, B1, B2.
    expect(assetsOf(site)).toEqual(expect.arrayContaining(['index-live.js', 'SessionView-live.js']));

    const third = deploy(site, dist(B3, ['index-b3.js', VENDOR]));
    expect(third.status, third.stderr).toBe(0);
    expect(assetsOf(site)).toEqual(['index-b1.js', 'index-b2.js', 'index-b3.js', VENDOR].sort());
    expect(fs.existsSync(path.join(site, BUILDS_DIR, `${ADOPTED_BUILD}.json`))).toBe(false);
    expect(fs.readdirSync(path.join(site, BUILDS_DIR)).sort()).toEqual([`${B1}.json`, `${B2}.json`, `${B3}.json`]);
    expect(third.stdout).toContain(`pruned     ${ADOPTED_BUILD} (the site as it was before its builds were recorded) — 2 files deleted`);
    // Never anything outside assets/ and builds/.
    expect(tree(site)['google1234567890abcdef.html']).toBeDefined();
    expect(tree(site)['.nojekyll']).toBe('');
  });
});

describe('a deploy keeps the files of the last three builds', () => {
  it(`keeps ${KEEP_BUILDS}, this one included`, () => {
    expect(KEEP_BUILDS).toBe(3);
  });

  it('a page of the build before last still finds its files; one build older, they are gone', () => {
    const site = folder('site');
    deploy(site, dist(B1, ['index-b1.js', 'Stats-b1.js', VENDOR]));
    deploy(site, dist(B2, ['index-b2.js', 'Stats-b1.js', VENDOR]));
    deploy(site, dist(B3, ['index-b3.js', 'Stats-b3.js', VENDOR]));
    expect(assetsOf(site)).toEqual(['Stats-b1.js', 'Stats-b3.js', 'index-b1.js', 'index-b2.js', 'index-b3.js', VENDOR].sort());

    const done = deploy(site, dist(B4, ['index-b4.js', 'Stats-b3.js', VENDOR]));
    expect(done.status, done.stderr).toBe(0);
    // B1 went. `Stats-b1.js` was also a file of B2, which stays; `vendor` is everybody's.
    expect(assetsOf(site)).toEqual(['Stats-b1.js', 'Stats-b3.js', 'index-b2.js', 'index-b3.js', 'index-b4.js', VENDOR].sort());
    expect(fs.readdirSync(path.join(site, BUILDS_DIR)).sort()).toEqual([`${B2}.json`, `${B3}.json`, `${B4}.json`]);
    expect(done.stdout).toContain(`kept       ${B4} (this build), ${B3}, ${B2}`);
    expect(done.stdout).toContain(`pruned     ${B1} — 1 file deleted`);
    // The files that stay are the ones that were published, byte for byte.
    expect(tree(site)[`${ASSETS_DIR}/index-b2.js`]).toBe('index-b2.js');
  });

  it('is the same tree when the same build is published twice', () => {
    const site = folder('site');
    deploy(site, dist(B1, ['index-b1.js', VENDOR]));
    deploy(site, dist(B2, ['index-b2.js', VENDOR]));
    const built = dist(B3, ['index-b3.js', VENDOR]);
    deploy(site, built);
    const once = tree(site);

    const again = deploy(site, built);
    expect(again.status, again.stderr).toBe(0);
    expect(tree(site)).toEqual(once);
    expect(fs.readdirSync(path.join(site, BUILDS_DIR)).sort()).toEqual([`${B1}.json`, `${B2}.json`, `${B3}.json`]);
  });

  it('starts a site nothing was published to: an empty folder, or none', () => {
    for (const site of [folder('site'), path.join(folder('nowhere'), 'published')]) {
      const done = deploy(site, dist(B1, ['index-b1.js', VENDOR]));
      expect(done.status, done.stderr).toBe(0);
      expect(names(site)).toEqual([
        `${ASSETS_DIR}/index-b1.js`, `${ASSETS_DIR}/${VENDOR}`, `${BUILDS_DIR}/${B1}.json`,
        'favicon.svg', 'index.html', 'manifest.webmanifest', 'sw.js', VERSION_FILE,
      ].sort());
      expect(done.stdout).not.toContain('adopted');
      expect(done.stdout).toContain('pruned     nothing: 1 build published, 3 are kept');
    }
  });

  it('adopts the tree the emergency publish leaves, which replaces everything and records nothing', () => {
    // `npm run deploy`: dist/ alone, a wave-2 build with its version.json and no builds/.
    const site = dist(B1, ['index-b1.js', VENDOR]);
    const done = deploy(site, dist(B2, ['index-b2.js', VENDOR]));

    expect(done.status, done.stderr).toBe(0);
    expect(assetsOf(site)).toEqual(['index-b1.js', 'index-b2.js', VENDOR].sort());
    expect(recordOf(site, ADOPTED_BUILD).files).toEqual([`${ASSETS_DIR}/index-b1.js`, `${ASSETS_DIR}/${VENDOR}`]);
  });

  it('keeps as many as it is told', () => {
    const site = folder('site');
    deploy(site, dist(B1, ['index-b1.js', VENDOR]));
    deploy(site, dist(B2, ['index-b2.js', VENDOR]));
    const done = deploy(site, dist(B3, ['index-b3.js', VENDOR]), ['--keep', '1']);
    expect(done.status, done.stderr).toBe(0);
    expect(assetsOf(site)).toEqual(['index-b3.js', VENDOR].sort());
    expect(fs.readdirSync(path.join(site, BUILDS_DIR))).toEqual([`${B3}.json`]);
  });

  it('says what it would do, and writes nothing, with --dry-run', () => {
    const site = liveSite();
    const before = tree(site);
    const done = deploy(site, dist(B1, ['index-b1.js', VENDOR]), ['--dry-run']);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain(`build      ${B1}, 2 files under ${ASSETS_DIR}/`);
    expect(done.stdout).toContain('Nothing was written (--dry-run).');
    expect(tree(site)).toEqual(before);
  });
});

// ------------------------------------------------------------
// What stops the run, with nothing written
// ------------------------------------------------------------
describe('a published tree it does not understand is left exactly as it was', () => {
  /** A site with three recorded builds, then `change`, then a fourth deploy. */
  function refused(change, env) {
    const site = folder('site');
    deploy(site, dist(B1, ['index-b1.js', VENDOR]));
    deploy(site, dist(B2, ['index-b2.js', VENDOR]));
    deploy(site, dist(B3, ['index-b3.js', VENDOR]));
    change(site);
    const before = tree(site);
    const done = deploy(site, dist(B4, ['index-b4.js', VENDOR]), [], env);
    return { done, site, untouched: () => expect(tree(site)).toEqual(before) };
  }
  const recordFile = (site, build) => path.join(site, BUILDS_DIR, `${build}.json`);

  it('a record that is not JSON', () => {
    const { done, untouched } = refused((site) => fs.writeFileSync(recordFile(site, B2), '{ "build": '));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`STOPPED: the published site/${BUILDS_DIR}/${B2}.json cannot be read`);
    expect(done.stderr).toContain(`Nothing is published by this run. ${PAGE}`);
    untouched();
  });

  it.each([
    ['a path that climbs out of its folder', `${ASSETS_DIR}/../index.html`, 'leaves its folder'],
    ['a path that climbs out of the tree', '../../etc/passwd', 'leaves its folder'],
    ['an absolute path', '/etc/passwd', 'is an absolute path'],
    ['a file of the tree that is not a build\'s', 'index.html', `is not under ${ASSETS_DIR}/`],
    ['the worker', 'sw.js', `is not under ${ASSETS_DIR}/`],
    ['the folder itself', ASSETS_DIR, `is not under ${ASSETS_DIR}/`],
    ['a record', `${BUILDS_DIR}/${B3}.json`, `is not under ${ASSETS_DIR}/`],
    ['a path written for another system', `${ASSETS_DIR}\\..\\index.html`, 'holds a character'],
    ['a path with an empty part', `${ASSETS_DIR}//index-b2.js`, 'leaves its folder'],
  ])('a record that names %s', (_what, file, why) => {
    // The oldest record: the one whose files this deploy deletes.
    const { done, site, untouched } = refused((dir) => fs.writeFileSync(
      recordFile(dir, B1),
      JSON.stringify({ build: B1, files: [`${ASSETS_DIR}/index-b1.js`, file] }),
    ));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`${BUILDS_DIR}/${B1}.json names ${JSON.stringify(file)}, which ${why}`);
    untouched();
    expect(fs.existsSync(path.join(site, 'index.html'))).toBe(true);
  });

  it('a record that says it is another build', () => {
    const { done, untouched } = refused((site) => fs.writeFileSync(recordFile(site, B1), record(B3, ['index-b1.js'])));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`${BUILDS_DIR}/${B1}.json says it is the build "${B3}"`);
    untouched();
  });

  it('a record without a list of files, and one that is not a record', () => {
    const noList = refused((site) => fs.writeFileSync(recordFile(site, B1), JSON.stringify({ build: B1 })));
    expect(noList.done.status).toBe(1);
    expect(noList.done.stderr).toContain('has no list of files');
    noList.untouched();

    const list = refused((site) => fs.writeFileSync(recordFile(site, B1), '[]'));
    expect(list.done.status).toBe(1);
    expect(list.done.stderr).toContain('is not a record');
    list.untouched();
  });

  it('something in builds/ that is not a record', () => {
    const { done, untouched } = refused((site) => fs.writeFileSync(path.join(site, BUILDS_DIR, 'notes.txt'), 'x'));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`${BUILDS_DIR}/notes.txt is not the record of a build`);
    untouched();
  });

  it('a link where the files of the builds should be', () => {
    const elsewhere = write(folder('elsewhere'), { 'precious.txt': 'not a build\'s' });
    const { done, untouched } = refused((site) => {
      fs.rmSync(path.join(site, ASSETS_DIR), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(site, ASSETS_DIR));
    });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`the published site/${ASSETS_DIR} is not a folder`);
    untouched();
    expect(tree(elsewhere)).toEqual({ 'precious.txt': 'not a build\'s' });
  });

  it('a link among the files of the builds', () => {
    const elsewhere = write(folder('elsewhere'), { 'precious.txt': 'x' });
    const { done, untouched } = refused((site) => fs.symlinkSync(path.join(elsewhere, 'precious.txt'), path.join(site, ASSETS_DIR, 'index-b1.js.map')));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`${ASSETS_DIR}/index-b1.js.map is a link, not a file`);
    untouched();
    expect(tree(elsewhere)).toEqual({ 'precious.txt': 'x' });
  });

  it('says it as an annotation of the run, on GitHub', () => {
    const { done } = refused((site) => fs.writeFileSync(recordFile(site, B2), 'not json'), { GITHUB_ACTIONS: 'true' });
    expect(done.status).toBe(1);
    expect(done.stdout).toMatch(/^::error title=Deploy stopped::The published tree could not be prepared: the published site\/builds\/20261011080000\.json cannot be read/m);
  });
});

describe('a build it cannot place is not published', () => {
  const site = () => write(folder('site'), { 'index.html': 'live' });

  it('a folder that is not a build', () => {
    const done = deploy(site(), path.join(tmp, 'no-such-dist'));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('is not a folder: run `npm run build` first');
  });

  it('a build without its version.json', () => {
    const built = dist(B1, ['index-b1.js']);
    fs.rmSync(path.join(built, VERSION_FILE));
    const published = site();
    const done = deploy(published, built);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`${VERSION_FILE} is missing or is not a version`);
    expect(tree(published)).toEqual({ 'index.html': 'live' });
  });

  it('a page and a version.json that are not of the same build', () => {
    const built = dist(B1, ['index-b1.js']);
    fs.writeFileSync(path.join(built, VERSION_FILE), JSON.stringify({ build: B2, minBuild: null }));
    const done = deploy(site(), built);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`index.html is the build "${B1}" and ${VERSION_FILE} says "${B2}"`);
  });

  it('a page without an id', () => {
    const built = dist(B1, ['index-b1.js']);
    fs.writeFileSync(path.join(built, 'index.html'), '<!doctype html><html><head></head></html>');
    const done = deploy(site(), built);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`index.html is the build null and ${VERSION_FILE} says "${B1}"`);
  });

  it('a build that calls itself the adopted one', () => {
    const done = deploy(site(), dist(ADOPTED_BUILD, ['index-x.js']));
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('is the id of an adopted tree, not of a build');
  });

  it('reads the id the way the page reads it', () => {
    const built = dist(B1, ['index-b1.js', VENDOR], { minBuild: '20261001000000' });
    expect(readDist(built)).toEqual({
      build: B1,
      minBuild: '20261001000000',
      files: [`${ASSETS_DIR}/index-b1.js`, `${ASSETS_DIR}/${VENDOR}`],
    });
    expect(BUILD_META).toBe('sl-build');
  });
});

describe('the command line', () => {
  it('needs both folders', () => {
    for (const args of [[], ['--site', 'x'], ['--dist', 'x']]) {
      const done = run(args);
      expect(done.status).toBe(2);
      expect(done.stderr).toContain('Give --site and --dist.');
    }
  });

  it('refuses what it does not know, and a number of builds that keeps none', () => {
    expect(run(['--site', 'x', '--dist', 'y', '--force']).status).toBe(2);
    for (const keep of ['0', '-1', 'two', '1.5', '']) {
      const done = run(['--site', 'x', '--dist', 'y', `--keep=${keep}`]);
      expect(done.status).toBe(2);
      expect(done.stderr).toContain('--keep is a number of builds, 1 or more');
    }
  });

  it('explains itself', () => {
    const done = run(['--help']);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('Usage: node scripts/prune-gh-pages.mjs --site <dir> --dist <dir>');
    expect(done.stdout).toContain(PAGE);
  });
});

// ------------------------------------------------------------
// The decision alone: planSite touches nothing
// ------------------------------------------------------------
describe('planSite', () => {
  const a = (...list) => list.map((name) => `${ASSETS_DIR}/${name}`);
  const rec = (build, ...list) => ({ build, files: a(...list) });
  const mine = (build, ...list) => ({ build, files: a(...list) });

  it('keeps the records with the latest ids, whatever order they were read in', () => {
    const plan = planSite({
      site: {
        assets: a('one.js', 'two.js', 'three.js'),
        records: [rec(B2, 'two.js'), rec(B3, 'three.js'), rec(B1, 'one.js')],
      },
      build: mine(B4, 'four.js'),
    });
    expect(plan.kept.map((r) => r.build)).toEqual([B4, B3, B2]);
    expect(plan.pruned.map((r) => r.build)).toEqual([B1]);
    expect(plan.remove).toEqual(a('one.js'));
    expect(plan.adopted).toBeNull();
    expect(plan.outOfOrder).toBe(false);
  });

  it('never deletes a file a kept build names, nor one this build brings', () => {
    const plan = planSite({
      site: {
        assets: a('old.js', 'shared-with-kept.js', 'shared-with-new.js', 'kept.js'),
        records: [rec(B1, 'old.js', 'shared-with-kept.js', 'shared-with-new.js'), rec(B2, 'shared-with-kept.js'), rec(B3, 'kept.js')],
      },
      build: mine(B4, 'shared-with-new.js', 'new.js'),
    });
    expect(plan.remove).toEqual(a('old.js'));
  });

  it('never deletes a file no record names', () => {
    const plan = planSite({
      site: {
        assets: a('by-hand.js', 'one.js', 'two.js', 'three.js'),
        records: [rec(B1, 'one.js'), rec(B2, 'two.js'), rec(B3, 'three.js')],
      },
      build: mine(B4, 'four.js'),
    });
    expect(plan.remove).toEqual(a('one.js'));
    expect(plan.unclaimed).toEqual(a('by-hand.js'));
    expect(render(plan).notes).toEqual([
      expect.objectContaining({ level: 'notice', text: expect.stringContaining('1 file under assets/ is named by no record and was left alone: assets/by-hand.js') }),
    ]);
  });

  it('does not adopt when records exist, and does when none does', () => {
    const withRecords = planSite({
      site: { assets: a('one.js', 'stray.js'), records: [rec(B1, 'one.js')] },
      build: mine(B2, 'two.js'),
    });
    expect(withRecords.adopted).toBeNull();
    expect(withRecords.remove).toEqual([]);

    const without = planSite({ site: { assets: a('one.js', 'stray.js'), records: [] }, build: mine(B2, 'two.js') });
    expect(without.adopted).toEqual({ build: ADOPTED_BUILD, files: a('one.js', 'stray.js') });
    expect(without.kept.map((r) => r.build)).toEqual([B2, ADOPTED_BUILD]);
    expect(without.remove).toEqual([]);

    const empty = planSite({ site: { assets: [], records: [] }, build: mine(B1, 'one.js') });
    expect(empty.adopted).toBeNull();
    expect(empty.kept.map((r) => r.build)).toEqual([B1]);
  });

  it('replaces the record of a build that is published again, and counts it once', () => {
    const plan = planSite({
      site: {
        assets: a('one.js', 'two.js', 'three.js', 'three-first-try.js'),
        records: [rec(B1, 'one.js'), rec(B2, 'two.js'), rec(B3, 'three-first-try.js')],
      },
      build: mine(B3, 'three.js'),
    });
    expect(plan.kept.map((r) => r.build)).toEqual([B3, B2, B1]);
    expect(plan.kept[0].files).toEqual(a('three.js'));
    expect(plan.pruned).toEqual([]);
    // The file only the first try had is named by no record any more: left alone, and said.
    expect(plan.remove).toEqual([]);
    expect(plan.unclaimed).toEqual(a('three-first-try.js'));
  });

  it('keeps this build even when a published one has a later id, and says so', () => {
    const plan = planSite({
      site: { assets: a('two.js', 'three.js', 'four.js'), records: [rec(B2, 'two.js'), rec(B3, 'three.js'), rec(B4, 'four.js')] },
      build: mine(B1, 'one.js'),
    });
    expect(plan.kept.map((r) => r.build)).toEqual([B1, B4, B3]);
    expect(plan.outOfOrder).toBe(true);
    expect(render(plan).notes.map((note) => note.title)).toContain('Build ids out of order');
  });

  it('says when a kept build has lost files', () => {
    const plan = planSite({
      site: { assets: a('two.js'), records: [rec(B1, 'one.js'), rec(B2, 'two.js', 'gone.js')] },
      build: mine(B3, 'three.js'),
    });
    expect(plan.missing).toEqual([{ build: B2, file: `${ASSETS_DIR}/gone.js` }, { build: B1, file: `${ASSETS_DIR}/one.js` }]);
    expect(render(plan).notes).toEqual([expect.objectContaining({ level: 'warning', title: 'A kept build has lost files' })]);
  });

  it('refuses to keep no build at all', () => {
    const site = { assets: [], records: [] };
    expect(() => planSite({ site, build: mine(B1), keep: 0 })).toThrow(SiteError);
    expect(() => planSite({ site, build: mine(B1), keep: 1.5 })).toThrow(SiteError);
  });

  it('is said in a few lines', () => {
    const plan = planSite({
      site: { assets: a('one.js', 'two.js', 'three.js'), records: [rec(B1, 'one.js'), rec(B2, 'two.js'), rec(B3, 'three.js')] },
      build: mine(B4, 'four.js', 'five.js'),
    });
    expect(render(plan)).toEqual({
      out: [
        `  build      ${B4}, 2 files under assets/`,
        `  kept       ${B4} (this build), ${B3}, ${B2}`,
        `  pruned     ${B1} — 1 file deleted`,
      ],
      notes: [],
    });
  });
});

describe('applyPlan', () => {
  it('deletes under assets/ and builds/ only, even handed a plan that says otherwise', () => {
    const site = write(folder('site'), { 'index.html': 'live', [`${ASSETS_DIR}/one.js`]: 'one' });
    const built = dist(B1, ['index-b1.js']);
    const plan = planSite({ site: readSite(site), build: readDist(built) });

    for (const file of ['index.html', `${ASSETS_DIR}/../index.html`, '../outside', '/etc/hostname']) {
      expect(() => applyPlan({ ...plan, remove: [file] }, { siteDir: site, distDir: built })).toThrow(SiteError);
    }
    expect(tree(site)).toEqual({ 'index.html': 'live', [`${ASSETS_DIR}/one.js`]: 'one' });
  });

  it('writes a file of the build over a link, never through it', () => {
    const elsewhere = write(folder('elsewhere'), { 'precious.txt': 'x' });
    const site = folder('site');
    fs.symlinkSync(path.join(elsewhere, 'precious.txt'), path.join(site, 'index.html'));
    const built = dist(B1, ['index-b1.js']);

    applyPlan(planSite({ site: readSite(site), build: readDist(built) }), { siteDir: site, distDir: built });

    expect(tree(elsewhere)).toEqual({ 'precious.txt': 'x' });
    expect(fs.lstatSync(path.join(site, 'index.html')).isSymbolicLink()).toBe(false);
    expect(tree(site)['index.html']).toContain(B1);
  });
});

describe('assetPathFault — what a record may name', () => {
  it('a file under assets/, at any depth', () => {
    expect(assetPathFault(`${ASSETS_DIR}/index-a1.js`)).toBeNull();
    expect(assetPathFault(`${ASSETS_DIR}/fonts/inter-latin.woff2`)).toBeNull();
    expect(assetPathFault(`${ASSETS_DIR}/..hidden.js`)).toBeNull(); // two dots in a name are not a way out
  });

  it('nothing else', () => {
    for (const file of [
      '', null, undefined, 42, ASSETS_DIR, `${ASSETS_DIR}/`, `/${ASSETS_DIR}/a.js`, `${ASSETS_DIR}/../a.js`,
      `${ASSETS_DIR}/./a.js`, `./${ASSETS_DIR}/a.js`, '../a.js', 'index.html', `${BUILDS_DIR}/a.json`,
      `${ASSETS_DIR}x/a.js`, `${ASSETS_DIR}\\a.js`, `${ASSETS_DIR}/a\0.js`, 'C:\\assets\\a.js',
    ]) {
      expect(assetPathFault(file), JSON.stringify(file)).not.toBeNull();
    }
  });
});
