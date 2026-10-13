#!/usr/bin/env node
// The tree a deploy publishes: the new build on top of the builds before it.
//
//   node scripts/prune-gh-pages.mjs --site <published tree> --dist dist
//
// `--site` is a copy of what is published now (the `gh-pages` branch, as
// .github/workflows/deploy.yml reads it); `--dist` is the build that was just
// made. When the command ends with 0, the folder of `--site` is the tree to
// publish: every file of the new build, the files of the two builds before it,
// and one record per build under builds/. The builds older than that are gone,
// with the files only they had.
//
// It ends with 1 — and has written nothing — when the published tree or the
// build is not what it expects: a record it cannot read, a record that names a
// path outside assets/, a build without its version.json. The deploy stops
// there. The rules are in lib/published-builds.mjs; what to do when it says
// no, in docs/runbook/40-deploy.md.
//
// It talks to no network and to no git: two folders in, one folder out.

import { parseArgs } from 'node:util';
import {
  KEEP_BUILDS, PAGE, SiteError, applyPlan, planSite, readDist, readSite, render,
} from './lib/published-builds.mjs';

const usage = `Usage: node scripts/prune-gh-pages.mjs --site <dir> --dist <dir> [--keep <n>] [--dry-run]

  --site <dir>   the published tree, as it is now. It becomes the tree to publish.
                 A folder that does not exist is a site nothing was published to.
  --dist <dir>   the build to add: the output of \`npm run build\`
  --keep <n>     how many builds stay published, this one included (default ${KEEP_BUILDS})
  --dry-run      say what would be kept and deleted, and write nothing
  -h, --help     this text

Exit code
  0  the tree is ready (or: described, with --dry-run)
  1  nothing was written: the published tree or the build is not what this expects
  2  the command line is wrong

What to do when it says no: ${PAGE}`;

/** Exit code for "the command line is wrong" — as the other commands have it. */
const USAGE = 2;

const say = (line = '') => process.stdout.write(`${line}\n`);
const warn = (line = '') => process.stderr.write(`${line}\n`);

// In a workflow command, `%` and line breaks are escaped; a message is one line.
const annotation = ({ level, title, text }) => (
  `::${level} title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
);
const onGitHub = process.env.GITHUB_ACTIONS === 'true';

function run() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        site: { type: 'string' },
        dist: { type: 'string' },
        keep: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    warn(`${err.message}\n\n${usage}`);
    return USAGE;
  }
  if (values.help) {
    say(usage);
    return 0;
  }
  if (!values.site || !values.dist) {
    warn(`Give --site and --dist.\n\n${usage}`);
    return USAGE;
  }
  const keep = values.keep === undefined ? KEEP_BUILDS : Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) {
    warn(`--keep is a number of builds, 1 or more; got "${values.keep}".\n\n${usage}`);
    return USAGE;
  }

  say('sl_app deploy — the new build joins the builds that are published');
  const build = readDist(values.dist);
  const site = readSite(values.site);
  const plan = planSite({ site, build, keep });
  const { out, notes } = render(plan);
  for (const line of out) say(line);
  if (onGitHub) for (const note of notes) say(annotation(note));
  if (values['dry-run']) {
    say('\nNothing was written (--dry-run).');
    return 0;
  }
  applyPlan(plan, { siteDir: values.site, distDir: values.dist });
  say(`\n${values.site} is the tree to publish.`);
  return 0;
}

try {
  process.exitCode = run();
} catch (err) {
  // A refusal (SiteError) or a bug: either way the tree is not one to publish.
  const text = err instanceof SiteError ? err.message : `${err?.message ?? err}`;
  warn(`\nSTOPPED: ${text}.\nNothing is published by this run. ${PAGE}`);
  if (!(err instanceof SiteError) && err?.stack) warn(err.stack);
  if (onGitHub) say(annotation({ level: 'error', title: 'Deploy stopped', text: `The published tree could not be prepared: ${text}. ${PAGE}` }));
  process.exitCode = 1;
}
