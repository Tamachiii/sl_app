// What a deploy keeps of the builds before it, and what it deletes.
//
// The screens of the app are files with a name that changes with their
// content (dist/assets/…), and index.html names the ones of its build. A page
// that was opened before a deploy still asks for the files of ITS build when
// a screen is opened for the first time. The deploy used to replace the whole
// published tree with the new build, so those files were gone the moment it
// went out, and the screen failed (review finding P65).
//
// The deploy now publishes the new build ON TOP of what is published, and
// each build leaves a record of its files:
//
//   builds/<build id>.json   { "build": "<id>", "files": ["assets/…", …] }
//
// The newest KEEP_BUILDS records are kept, this build included. The records
// older than that are deleted with every file they name that no kept build
// also names — a file that did not change between two builds has the same
// name in both.
//
// What can be deleted is narrow on purpose:
//
//   - only files under assets/, and only files a record names. Everything
//     else of the tree — index.html, sw.js, version.json, the manifest, the
//     icons, a file somebody put there by hand — is left alone; every build
//     overwrites the ones it has.
//   - a record that cannot be read, or that names a path outside assets/,
//     stops the run before anything is written (SiteError). The deploy then
//     stops too: a tree nobody understands is not pruned, and not added to.
//
// A tree without any record — the site as it was before this, or after the
// emergency publish, which replaces everything — is adopted: its files under
// assets/ become the build ADOPTED_BUILD, older than every other, so the pages
// that still run it keep their files until KEEP_BUILDS newer builds exist.
//
// Nothing here talks to git or to the network: the workflow hands over two
// folders (.github/workflows/deploy.yml), and scripts/prune-gh-pages.mjs is
// the command. `planSite` decides and touches nothing; `applyPlan` does what
// the plan says.

import fs from 'node:fs';
import path from 'node:path';
import { BUILD_META, VERSION_FILE, parseVersion } from '../../src/lib/buildInfo.js';

/** How many builds stay published, the new one included. */
export const KEEP_BUILDS = 3;
/** The one folder a build's own files live in (Vite's `build.assetsDir`), and the only one pruned. */
export const ASSETS_DIR = 'assets';
/** Where the records are. */
export const BUILDS_DIR = 'builds';
/** The id of a tree that was published before the records existed: older than every build. */
export const ADOPTED_BUILD = '00000000000000';
/** The owner's page. */
export const PAGE = 'docs/runbook/40-deploy.md';

/** The run must stop, and nothing was written. */
export class SiteError extends Error {}

const RECORD_NAME = /^([\w.-]{1,64})\.json$/;

/** Why `file` cannot be a file of a build, or null. */
export function assetPathFault(file) {
  if (typeof file !== 'string' || file === '') return 'is not a path';
  if (file.includes('\\') || file.includes('\0')) return 'holds a character no file of a build has';
  if (file.startsWith('/')) return 'is an absolute path';
  const parts = file.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'leaves its folder';
  if (parts[0] !== ASSETS_DIR || parts.length < 2) return `is not under ${ASSETS_DIR}/`;
  return null;
}

const lstat = (file) => fs.lstatSync(file, { throwIfNoEntry: false });

/** The files under `dir`, as paths from `root` with `/`. A link is refused: it could point anywhere. */
function filesUnder(root, dir, say) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new SiteError(`${say}/${rel} is a link, not a file`);
    if (entry.isDirectory()) out.push(...filesUnder(root, rel, say));
    else if (entry.isFile()) out.push(rel);
    else throw new SiteError(`${say}/${rel} is neither a file nor a folder`);
  }
  return out;
}

/** A folder of the tree: `false` when it is not there, refused when it is something else. */
function folder(root, name, say) {
  const stat = lstat(path.join(root, name));
  if (!stat) return false;
  if (!stat.isDirectory()) throw new SiteError(`${say}/${name} is not a folder`);
  return true;
}

function readRecord(file, id, say) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SiteError(`${say} cannot be read: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SiteError(`${say} is not a record`);
  if (value.build !== id) throw new SiteError(`${say} says it is the build ${JSON.stringify(value.build)}`);
  if (!Array.isArray(value.files)) throw new SiteError(`${say} has no list of files`);
  for (const one of value.files) {
    const fault = assetPathFault(one);
    if (fault) throw new SiteError(`${say} names ${JSON.stringify(one)}, which ${fault}`);
  }
  return { build: id, files: [...new Set(value.files)].sort() };
}

/**
 * What is published: the files under assets/ and the records. A folder that is
 * not there is a site nothing was published to yet.
 */
export function readSite(siteDir) {
  const say = 'the published site';
  const root = lstat(siteDir);
  if (!root) return { assets: [], records: [] };
  if (!root.isDirectory()) throw new SiteError(`${siteDir} is not a folder`);
  const assets = folder(siteDir, ASSETS_DIR, say) ? filesUnder(siteDir, ASSETS_DIR, say).sort() : [];
  const records = [];
  if (folder(siteDir, BUILDS_DIR, say)) {
    for (const entry of fs.readdirSync(path.join(siteDir, BUILDS_DIR), { withFileTypes: true })) {
      const name = `${BUILDS_DIR}/${entry.name}`;
      const match = entry.isFile() ? entry.name.match(RECORD_NAME) : null;
      if (!match) throw new SiteError(`${say}/${name} is not the record of a build`);
      records.push(readRecord(path.join(siteDir, BUILDS_DIR, entry.name), match[1], `${say}/${name}`));
    }
  }
  return { assets, records };
}

/** The build that was just made: its id, the same in version.json and in index.html, and its files. */
export function readDist(distDir) {
  if (!lstat(distDir)?.isDirectory()) throw new SiteError(`${distDir} is not a folder: run \`npm run build\` first`);
  let version = null;
  try {
    version = parseVersion(JSON.parse(fs.readFileSync(path.join(distDir, VERSION_FILE), 'utf8')));
  } catch {
    version = null;
  }
  if (!version) throw new SiteError(`${distDir}/${VERSION_FILE} is missing or is not a version: the build did not write its id`);
  if (version.build === ADOPTED_BUILD) throw new SiteError(`${ADOPTED_BUILD} is the id of an adopted tree, not of a build`);
  let page = '';
  try {
    page = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    throw new SiteError(`${distDir}/index.html is missing`);
  }
  const tag = page.match(new RegExp(`<meta\\b[^>]*\\bname=["']${BUILD_META}["'][^>]*>`, 'i'));
  const inPage = tag ? tag[0].match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? null : null;
  if (inPage !== version.build) {
    throw new SiteError(
      `${distDir}/index.html is the build ${JSON.stringify(inPage)} and ${VERSION_FILE} says ${JSON.stringify(version.build)}: `
        + 'the two files are not of the same build',
    );
  }
  const files = folder(distDir, ASSETS_DIR, distDir) ? filesUnder(distDir, ASSETS_DIR, distDir).sort() : [];
  for (const one of files) {
    const fault = assetPathFault(one);
    if (fault) throw new SiteError(`${distDir}/${one} ${fault}`);
  }
  return { build: version.build, minBuild: version.minBuild, files };
}

const newestFirst = (a, b) => {
  if (a.build === b.build) return 0;
  return a.build < b.build ? 1 : -1;
};

/**
 * Decide, and touch nothing. `site` is readSite(), `build` is readDist().
 *
 *   kept       the records that stay, this build first, then newest first
 *   pruned     the records that go
 *   remove     the files that go with them
 *   adopted    the record made for a tree that had none, or null
 *   unclaimed  files under assets/ no record names: left alone
 *   missing    files a kept record names that are no longer published
 *   outOfOrder a published build has an id after this one's
 */
export function planSite({ site, build, keep = KEEP_BUILDS }) {
  if (!Number.isInteger(keep) || keep < 1) throw new SiteError(`cannot keep ${keep} builds: at least this one stays`);
  const mine = { build: build.build, files: [...build.files].sort() };
  const adopted = site.records.length === 0 && site.assets.length > 0
    ? { build: ADOPTED_BUILD, files: [...site.assets] }
    : null;
  // A record of this very id is this build, published before: replaced.
  const before = (adopted ? [adopted] : site.records.filter((record) => record.build !== mine.build)).sort(newestFirst);
  const kept = [mine, ...before.slice(0, keep - 1)];
  const pruned = before.slice(keep - 1);

  const needed = new Set(kept.flatMap((record) => record.files));
  const leaving = new Set(pruned.flatMap((record) => record.files));
  const named = new Set([...needed, ...leaving]);
  const published = new Set(site.assets);
  const brought = new Set(mine.files);

  return {
    build: mine.build,
    keep,
    kept,
    pruned,
    adopted,
    remove: site.assets.filter((file) => leaving.has(file) && !needed.has(file)),
    unclaimed: site.assets.filter((file) => !named.has(file)),
    missing: kept.slice(1).flatMap((record) => record.files
      .filter((file) => !published.has(file) && !brought.has(file))
      .map((file) => ({ build: record.build, file }))),
    outOfOrder: before.some((record) => record.build > mine.build),
  };
}

/** `file` inside `root`, refused if it is not: the last check before a file is deleted or written. */
function inside(root, file) {
  const full = path.resolve(root, ...file.split('/'));
  const rel = path.relative(path.resolve(root), full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new SiteError(`${file} is outside ${root}`);
  return full;
}

/** Copy the folder `from` over `to`. What is in the way of a file — a link, another file — is replaced by it. */
function copyOver(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const there = lstat(target);
    if (entry.isDirectory()) {
      if (there && !there.isDirectory()) fs.rmSync(target, { force: true });
      copyOver(source, target);
    } else if (entry.isFile()) {
      if (there) fs.rmSync(target, { recursive: true, force: true });
      fs.copyFileSync(source, target);
    } else {
      throw new SiteError(`${source} is neither a file nor a folder`);
    }
  }
}

const recordText = (record) => `${JSON.stringify({ build: record.build, files: record.files }, null, 2)}\n`;

/** Do what `plan` says: `siteDir` becomes the tree to publish. */
export function applyPlan(plan, { siteDir, distDir }) {
  fs.mkdirSync(siteDir, { recursive: true });
  for (const file of plan.remove) {
    const fault = assetPathFault(file);
    if (fault) throw new SiteError(`${file} ${fault}`);
    fs.rmSync(inside(siteDir, file), { force: true });
  }
  for (const record of plan.pruned) {
    fs.rmSync(inside(siteDir, `${BUILDS_DIR}/${record.build}.json`), { force: true });
  }
  copyOver(distDir, siteDir);
  fs.mkdirSync(path.join(siteDir, BUILDS_DIR), { recursive: true });
  for (const record of plan.kept) {
    if (record.build !== plan.build && record !== plan.adopted) continue; // already there, as it was read
    fs.writeFileSync(inside(siteDir, `${BUILDS_DIR}/${record.build}.json`), recordText(record));
  }
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (record, plan) => {
  if (record.build === plan.build) return `${record.build} (this build)`;
  if (record.build === ADOPTED_BUILD) return `${record.build} (the site as it was before its builds were recorded)`;
  return record.build;
};

/** What is said: `out` for the log, `notes` for the annotations of a run on GitHub. */
export function render(plan) {
  const out = [
    `  build      ${plan.build}, ${count(plan.kept[0].files.length, 'file')} under ${ASSETS_DIR}/`,
    `  kept       ${plan.kept.map((record) => nameOf(record, plan)).join(', ')}`,
  ];
  const notes = [];
  if (plan.adopted) {
    out.push(`  adopted    the ${count(plan.adopted.files.length, 'file')} that were published without a record, as the build ${ADOPTED_BUILD}`);
  }
  if (plan.pruned.length === 0) {
    out.push(`  pruned     nothing: ${count(plan.kept.length, 'build')} published, ${plan.keep} are kept`);
  } else {
    out.push(`  pruned     ${plan.pruned.map((record) => nameOf(record, plan)).join(', ')} — ${count(plan.remove.length, 'file')} deleted`);
  }
  if (plan.unclaimed.length > 0) {
    const text = `${count(plan.unclaimed.length, 'file')} under ${ASSETS_DIR}/ ${plan.unclaimed.length === 1 ? 'is' : 'are'} named by no record and ${plan.unclaimed.length === 1 ? 'was' : 'were'} left alone: ${plan.unclaimed.slice(0, 5).join(', ')}${plan.unclaimed.length > 5 ? ', …' : ''}`;
    out.push(`  left       ${text}`);
    notes.push({ level: 'notice', title: 'Published files without a record', text: `${text}. ${PAGE}` });
  }
  if (plan.missing.length > 0) {
    const text = `${count(plan.missing.length, 'file')} of the kept builds ${plan.missing.length === 1 ? 'is' : 'are'} no longer published (${plan.missing.slice(0, 3).map((one) => `${one.file} of ${one.build}`).join(', ')}${plan.missing.length > 3 ? ', …' : ''}): a page of that build reloads when it asks for one`;
    out.push(`  missing    ${text}`);
    notes.push({ level: 'warning', title: 'A kept build has lost files', text: `${text}. ${PAGE}` });
  }
  if (plan.outOfOrder) {
    const text = `a published build has an id after ${plan.build}: ids are the time of the build, and the builds kept are the ones with the latest ids`;
    out.push(`  order      ${text}`);
    notes.push({ level: 'warning', title: 'Build ids out of order', text: `${text}. ${PAGE}` });
  }
  return { out, notes };
}
