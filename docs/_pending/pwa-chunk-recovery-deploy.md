# pwa-chunk-recovery-deploy — docs to fold (wave 2, items: none)

Each block: target doc, section, then the text to fold in.

Fold this file after `pwa-update-flow.md`: several blocks add to the sections and lines that file creates.

## docs/INVARIANTS.md — App updates (a new version waits for the page)

Add after the bullet that starts "**An update is considered at four moments":

- **A build below the oldest one still allowed is the one exception: its update goes in as soon as nothing would be lost.** The start of the updater and every question to the server (`check()` in [src/lib/appUpdate.js](../src/lib/appUpdate.js): the return to the app, `online`, the hourly tick) also read `version.json` (`readMinimum` → `fetchVersion` in [src/lib/buildInfo.js](../src/lib/buildInfo.js)). A page whose `BUILD_ID` is below the file's `minBuild` is `required` to update, and two things change — nothing else. `CHECK_MIN_GAP_MS` no longer holds its question back while it has no update (`mustAsk`): it asks for the new worker at every return to the app. And the probe is asked again every `REQUIRED_RETRY_MS` (`insist`): the end of a rest, a message that was sent, a dialog that closed are followed by the update within five seconds, where any other update waits for the next of the four moments. `insist` never offers (`consider({ offer: false })`), so "Later" keeps the card away until the next moment. Everything else is the ordinary flow: the same `AUTO_APPLIED_KEY` against a loop, no second attempt by the page after one that failed, the second asking in `arrive()`, nothing applied in a hidden window or on a page without a shell. `required` is not part of the state a component reads, and the card says nothing different. A read that fails — offline, not found, a page instead of the file — changes nothing: what was known stays known. **A page no service worker is registered for reads no `version.json`**: `start()` returns before it, and there is nothing to apply.
- **`version.json` is what the SERVER publishes now: never precached, and written by the build that wrote the id.** The `sl-build-id` plugin (`buildInfoPlugin`) emits it next to `index.html` — `{ "build": "<id>", "minBuild": "<id>" | null }` — from the id it writes into `<meta name="sl-build">`: one `makeBuildId` per build, so the two cannot differ, and `scripts/prune-gh-pages.mjs` refuses a `dist/` in which they do. `globPatterns` in `vite.config.js` has no `json`, on purpose: a copy in the precache would answer with what the worker was built with, which is the one thing the page already knows. Adding `json` to that list, an `additionalManifestEntries` entry or a runtime cache for the file breaks the minimum; `src/test/ciGuardrails.test.js` reads the pattern. The page asks with `cache: 'no-store'`; the host can still answer from its edge with the previous file for some ten minutes after a deploy.
- **`minBuild` is a time floor, set by the repository variable `MIN_CLIENT_BUILD` and written at build time.** A build id is the UTC time of its build (`YYYYMMDDHHmmss`), ids compare as strings, and "below" is `BUILD_ID < minBuild` (`isBelowMinimum`): the minimum is any time — the id of a build, or a moment between two builds — and every build made before it must update. `makeVersion` refuses a value that is not 14 digits — `2026-10-20` would pass for an id and compare as smaller than every build of the year, a minimum that does nothing — and a value later than the build itself: the page of that very build would be told for ever to update to a version that does not exist. The `deploy` job is then red at its build step and nothing is published. The variable takes effect with the next deploy and is written into every `version.json` after it, until it is changed or deleted. `NO_BUILD` is never below anything. An older app that is put back is a NEW build with a new id, so a minimum never keeps an old commit from being published again.

## docs/INVARIANTS.md — new section "A page older than the files the server keeps", after "App updates (a new version waits for the page)"

Add the section:

````markdown
## A page older than the files the server keeps

- **A file of the app that did not load is not a crash.** `isChunkLoadError` in [src/lib/chunkRecovery.js](../src/lib/chunkRecovery.js) is the one definition — by the browsers' wordings (`NOT_LOADED`), because the type is a `TypeError` here and a plain `Error` there; a request to the API that failed ("Failed to fetch") is not one. Three places go by it: the `vite:preloadError` listener of the same file, `ErrorBoundary` (`componentDidCatch` reports nothing — neither the error nor the component stack — and the screen says "A new version of the app is available" with one action, "Reload"), and the `unhandledrejection` handler of [src/lib/errorReporter.js](../src/lib/errorReporter.js) (a screen fetched ahead of its use by `lib/preload` is awaited by nobody). A wording a browser starts to use goes into `NOT_LOADED` with a row in `src/lib/chunkRecovery.test.js`.
- **Never "Try again" for it.** `React.lazy` keeps a rejected import for good: re-rendering the same tree fails on the same file. The way on is a reload, which brings the page of the build that is published.
- **The page reloads by itself for it once per build id, online, and only when the update flow's probe says nothing would be lost.** `recover()` in `chunkRecovery.js`, called for every `vite:preloadError` (installed by [src/main.jsx](../src/main.jsx), production builds only). `CHUNK_RELOADED_KEY` in `sessionStorage` holds the `BUILD_ID` of the build that reloaded itself: a page that finds its own id there is the same build again and does not try a second time, and where the guard cannot be written nothing reloads. It is a key of its own, not `AUTO_APPLIED_KEY` — the two reloads have different causes, and at worst a build reloads once for each. Offline the same error means "no network", and a page no worker serves would be reloaded into the browser's own error page. The probe is `appUpdater.busy()`: `true`, `false`, or `null` while no shell is mounted, which counts as "no" — nothing of what the probe is about can be in progress then. When any of this says no, the error goes on to `React.lazy` and to the boundary, where the person decides.
- **The `vite:preloadError` event is never cancelled.** `preventDefault()` makes Vite swallow the error, and the import then resolves to `undefined`: `React.lazy` fails a second time, on "Cannot read properties of undefined (reading 'default')" — which `isChunkLoadError` does not know, and which would be shown and reported as a crash.
- **This reload is not the update flow's, and does not wait for a worker.** It is a plain `location.reload()`: it asks the worker that serves the page now — or the server, when none does — for the page again. A page whose worker changed under it (`stale` in `appUpdate.js`) is the update flow's business first: the change of route that asks for the missing file is a moment, and `consider()` reloads the page there, online or not, when nothing would be lost. Chunk recovery is for the page the update flow knows nothing about: one that no worker serves, or whose worker lost its cache.
- **"Reload" on that screen waits for the writes a reload would drop, then reloads whatever happened.** `handleReload` in [components/ui/ErrorBoundary.jsx](../src/components/ui/ErrorBoundary.jsx) awaits `writesAreSafe` ([src/lib/pendingWrites.js](../src/lib/pendingWrites.js)) — the wait "Update" has — and then calls `recovery.reloadNow()` even when a write did not come back within `WRITES_WAIT_MS`: unlike the update card, this screen has replaced the whole app and offers nothing else to do. The query client is read through `static contextType = QueryClientContext`, not a hook, so the boundary still draws where no provider is above it. While the device is offline the screen does not promise a new version: it says the screen could not be loaded, and to try the reload.
- **Whoever reloads the page asks `appUpdater.busy()` first, or leaves it to a tap.** The app has three reloads: `doReload` in `appUpdate.js` (the update flow's one), `reload` in `chunkRecovery.js`, and the buttons of `ErrorBoundary` ("Reload", "Go home"), which are taps. A fourth follows the same rule.
- **A deploy publishes the new build ON TOP of what is published, and the files of the last three builds stay.** A page that was opened before a deploy asks for the files of ITS build when a screen is opened for the first time. The `deploy` job of `.github/workflows/deploy.yml` therefore copies the `gh-pages` branch into `published/` (step "What is published now": `git archive`, so no `.git` comes with it), runs `node scripts/prune-gh-pages.mjs --site published --dist dist`, and hands `published/` to the action. **`publish_dir` is `./published`, never `./dist`** — `dist/` alone is the old behaviour, in which every deploy took the files of every other build away. **No `keep_files`**: the action replaces the branch with the folder it is given, which already holds what stays; with `keep_files` nothing the script deleted would ever leave the branch. `src/test/ciGuardrails.test.js` holds the order of the steps, the folder, and runs the first step against a real repository.
- **The prune deletes only files under `assets/` that a record names, and stops rather than guess.** Each build leaves `builds/<build id>.json` — `{ "build", "files" }`, its files under `assets/`. `planSite` in [scripts/lib/published-builds.mjs](../scripts/lib/published-builds.mjs) keeps the `KEEP_BUILDS` (3) records with the latest ids, this build included and always kept, and deletes the others with every file they name that no kept record names — a file that did not change between two builds has the same name in both. Nothing outside `assets/` and `builds/` is ever deleted: `index.html`, `sw.js`, `version.json`, the manifest and the icons are overwritten by each build, and a file put on the branch by hand stays. A file under `assets/` that no record names stays too, and the run says so. A record that cannot be read or says it is another build, a record that names a path outside `assets/` (`..`, an absolute path, `index.html`), anything else in `builds/`, a link under `assets/`, a `dist/` whose `index.html` and `version.json` are not of the same build: `SiteError`, exit 1, **nothing written** — the job stops before the publish and the app that was live stays.
- **A published tree without records is adopted, not emptied.** That is the site as it was before wave 2, and the site after an emergency publish. Its files under `assets/` become the record of the build `ADOPTED_BUILD` (`00000000000000`, older than every id), so the pages that still run it keep their files until three newer builds exist. Adoption happens only when there is no record at all.
- **The files of a build live under `assets/`, and the script is told nowhere else.** `ASSETS_DIR` in `published-builds.mjs` is Vite's default `build.assetsDir`. Setting `assetsDir` in `vite.config.js` means changing it there in the same commit; the guardrails test fails on an `assetsDir` in the config.
- **One publish at a time, and a branch that could not be read stops the job.** The `deploy` job reads the branch, adds to it and writes it back: its `concurrency` group (`publish-site`, `cancel-in-progress: false`) keeps two runs from each publishing a tree without the other's build. The step that reads the branch tells "there is no `gh-pages` branch" (`git ls-remote --exit-code` ends with 2: an empty folder, a first deploy) from "it could not be read" (any other status: exit 1) — published as if nothing were there, the build would go out alone.
- **The emergency publish keeps nothing.** `npm run deploy` is `gh-pages -d dist`: it replaces the branch with the build of the owner's machine. The files of the builds before it and the records are gone; a page that was open since before reloads by itself at the next screen it opens for the first time, or shows the "Reload" screen. The deploy after it adopts what it finds.
````

## docs/ARCHITECTURE.md — App updates

Add after the bullet that starts "- **The fields** —":

- **The minimum** — `version.json`, next to `index.html`: `{ build, minBuild }`. It is emitted by the plugin that writes the build id into `index.html` (`buildInfoPlugin` in [src/lib/buildInfo.js](../src/lib/buildInfo.js): `makeVersion` at build time, with `MIN_CLIENT_BUILD` from the environment of the build), read by `fetchVersion` (`cache: 'no-store'`, `null` for anything that is not the file) and judged by `isBelowMinimum(BUILD_ID, version)`. The updater takes the reader as `readVersion` and calls it from `readMinimum`: at `start()`, and in every `check()`. Below the minimum the page is `required`: `check()` ignores `CHECK_MIN_GAP_MS` while no update is pending, and `insist` runs every `REQUIRED_RETRY_MS` — `consider({ offer: false })`, the ordinary question without the offer.
- **The page that cannot load a file** — [src/lib/chunkRecovery.js](../src/lib/chunkRecovery.js): `isChunkLoadError(error)`, `createChunkRecovery({ storage, buildId, reload, isOnline, isBusy })` and the app's one instance, `chunkRecovery`, installed by `src/main.jsx` on `window` for `vite:preloadError`. `recover(error)` reloads once per build id when the device is online and `appUpdater.busy()` is not `true`; `reloadNow()` is the reload a person asked for; `isReloading()` tells `ErrorBoundary` to say "Reloading…". It is separate from the updater on purpose: it needs no worker and works where none is registered.

Add after the paragraph that starts "Two windows:":

One page that three deploys went past, in a tab no worker serves (it was opened on Monday with a hard reload, which goes around the worker): the coach opens "Library" for the first time since then → the import asks the server for a file of Monday's build → three builds are kept, and Monday's is the fourth → 404 → Vite dispatches `vite:preloadError` → nothing is being written or typed, the device is online, this build has not reloaded itself yet → `location.reload()` → the page of the build that is published, on the same route. With a feedback half-written in another field of the page the reload does not happen: the import rejects, `ErrorBoundary` shows "A new version of the app is available", and "Reload" waits for the writes that are on their way.

Add to the paragraph that starts "Tests:":

`src/lib/chunkRecovery.test.js` holds the wordings and the guard, `src/components/ui/ErrorBoundary.test.jsx` the screen and its "Reload" over a real `QueryClient`, `src/lib/errorReporter.test.js` what reaches the list of errors, and the `version.json` half is in `src/lib/buildInfo.test.js` (the plugin's hooks run as a build runs them) and in the last `describe` of `src/lib/appUpdate.test.js`.

## docs/ARCHITECTURE.md — new section "What a deploy publishes", after "App updates"

Add the section:

````markdown
## What a deploy publishes

The `gh-pages` branch holds more than the last build:

```
index.html  sw.js  version.json  manifest.webmanifest  favicon.svg  icon-*.png   the last build's; every build overwrites them
assets/<name>-<hash>.js|css|woff2                                                the files of the last three builds
builds/<build id>.json                                                           one record per build that is kept
.nojekyll                                                                        written by the publish action
```

A record is `{ "build": "<id>", "files": ["assets/…", …] }`. The `deploy` job makes the tree in three steps: `git archive` of the branch into `published/`; `scripts/prune-gh-pages.mjs --site published --dist dist`; the action, with `publish_dir: ./published`.

The script is a command line over [scripts/lib/published-builds.mjs](../scripts/lib/published-builds.mjs), which talks to no git and no network — two folders in, one out:

- `readDist(dir)` — the id of the build (the same in `version.json` and in the `<meta>` of `index.html`, or it refuses) and its files under `assets/`.
- `readSite(dir)` — the files under `assets/` and the records of `builds/`; a folder that does not exist is a site nothing was published to.
- `planSite({ site, build, keep })` — decides and touches nothing: `kept` (this build, then the records with the latest ids), `pruned`, `remove`, `adopted` (the record made for a tree that had none), `unclaimed` (files no record names: left alone), `missing` (files a kept record names that are gone), `outOfOrder`.
- `applyPlan(plan, { siteDir, distDir })` — deletes `remove` and the pruned records, copies `dist/` over the tree (a file of the build replaces whatever is in its way, a link included), writes the record of the build, and the record of a tree it adopted.
- `render(plan)` — the lines of the log, and the annotations of the run on GitHub.

`SiteError` is a refusal: exit 1 and nothing written. `--dry-run` prints the plan. Tests: `scripts/prune-gh-pages.test.mjs` runs the command on folders (four deploys in a row from a tree without records, every refusal with the tree compared before and after) and `planSite` alone; `src/test/ciGuardrails.test.js` holds the workflow.
````

## docs/ENVIRONMENT.md — GitHub Actions: secrets and variables

Add after the row of `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`:

| `MIN_CLIENT_BUILD` | variable | the build of `deploy.yml` | normally absent. The oldest build still allowed to run, as a build id — the UTC time of the build, 14 digits (`YYYYMMDDHHmmss`). It is written into `version.json`, and an open app older than it updates as soon as nothing would be lost instead of offering the update. A value that is not 14 digits, or later than the build itself, fails the build and nothing is published: [runbook/40-deploy.md](runbook/40-deploy.md), section 8 |

## README.md — Deployment

Add after the paragraph that starts "Every deploy is a new version for every device":

A deploy does not replace what is published: the new build goes on top of it, and the files of the two builds before it stay (`scripts/prune-gh-pages.mjs`, a step of the `deploy` job). An app that was left open through a deploy, or two, still finds the screens of its own build. One left open through three or more reloads by itself when it opens a screen whose file is gone — once, and only when nothing is being written or typed — or says "A new version of the app is available" with a "Reload". Next to `index.html`, `version.json` names the build that is published and, when the repository variable `MIN_CLIENT_BUILD` is set, the oldest build still allowed to run: an open app older than that applies the update as soon as nothing would be lost, instead of offering it.

Add to the paragraph that starts "`npm run deploy` still exists as an emergency-only manual path":

It also replaces the whole published tree with the local build: the files of the builds before it are gone, and an app that was open since before reloads at the next screen it opens for the first time.

## README.md — Offline Support (Student Session Logging)

Add after the bullet that starts "- **Updates** —":

- **A screen whose file is gone** — every screen is a file fetched when it is first opened. On a page older than the files the server keeps, that request fails: the page reloads once by itself when nothing would be lost ([src/lib/chunkRecovery.js](src/lib/chunkRecovery.js)), and otherwise shows a screen with "Reload" instead of "Something went wrong". It is not written to the coach's list of errors.

## docs/runbook/40-deploy.md — 1. What a push to `main` runs

Replace the row of the table that starts "| `deploy` |" with:

| `deploy` | builds with the real keys, adds the build to what is published — the files of the two builds before it stay — and publishes to GitHub Pages | the build, the preparation of the published tree or the upload failed: section 8 |

## docs/runbook/40-deploy.md — 6. The emergency publish

Add at the end of the section:

It also replaces everything that is published with the build of your machine. The files of the builds before it are gone, and so are the records the deploy keeps of them (section 8). An app that was open since before then reloads by itself the next time it opens a screen it had not opened yet, or shows "A new version of the app is available" with a "Reload"; nothing is lost. The next deploy from `main` takes what it finds as one old build and keeps it like any other.

## docs/runbook/40-deploy.md — 7. Putting an older app back

Add after the paragraph that starts "`git revert` on `main`":

The app that is put back is a new build: it gets a new id (the time of its build) and goes on top of the builds that are published, like any deploy. `MIN_CLIENT_BUILD` (section 8) does not stand in its way — a minimum is a time, and this build is made now.

## docs/runbook/40-deploy.md — new section "8. What a deploy keeps, and making old apps update", after "7. Putting an older app back"

Add the section:

````markdown
## 8. What a deploy keeps, and making old apps update

**What it keeps.** An app that is open on a phone or in a tab keeps running the build it was opened with, and fetches each screen the first time that screen is opened. So a deploy does not replace what is published: it adds its build to it. The files of the last three builds stay on the `gh-pages` branch, this one included; the builds older than that are deleted with the files only they had. The branch has a folder `builds/` with one small file per build that is kept — the list of its files. You never edit it.

So an app that was left open through one deploy or two still finds every screen of its own build. One that was left open through three or more may ask for a screen it had not opened yet and no longer find it: it then reloads by itself — once, and only when nothing is being written or typed — or shows "A new version of the app is available" with a "Reload". Nothing is lost either way.

**The first deploy with this in it** finds a branch without `builds/`. It takes everything under `assets/` as one old build and keeps it: the log of the step says `adopted    the … files that were published without a record`. The same happens on the deploy after an emergency publish (section 6).

**When the `deploy` job is red.** Nothing was published: the app that was live is still live. Open the job and look at which step is red.

| Step | The message | Do |
|---|---|---|
| `npm run build` | `MIN_CLIENT_BUILD (…) is later than this build (…)` | the variable holds a time that has not come yet. Correct it (below) and re-run |
| `npm run build` | `MIN_CLIENT_BUILD must be the id of a build: its UTC time, 14 digits` | the value is something else: a word, a date with dashes, a digit too many. Correct it and re-run |
| `What is published now` | `The published branch could not be read` | GitHub did not answer. Re-run |
| `This build joins the builds that are published` | `STOPPED: the published site/builds/… cannot be read`, `… names …, which …`, `… says it is the build …`, `… is not the record of a build` | somebody changed the `gh-pages` branch by hand. On GitHub, open the branch `gh-pages`, the folder `builds`, then ⋯ → *Delete directory*, and commit. Re-run: the deploy takes what is published as one old build and starts its records again |
| `This build joins the builds that are published` | `STOPPED: … is a link, not a file`, `… is not a folder` | the same cause, and not something to repair blind. Stop and report the message |
| `This build joins the builds that are published` | `STOPPED: dist/version.json is missing`, `… are not of the same build` | a fault of the repository, not of what is published. Stop and report the message |

**Re-run** is section 4's: Actions → the red run → *Re-run failed jobs*.

A note or a warning on a green run — `Published files without a record`, `A kept build has lost files`, `Build ids out of order` — stops nothing. It means the branch was changed by something other than this deploy; mention it the next time you report.

**Making old apps update: `MIN_CLIENT_BUILD`.** Normally an open app is offered a new version and takes it when nothing is in progress, or when the person says so. That is enough almost always. It is not enough before a change to the database that an older app cannot live with — the `contract` migrations of Checkpoint Z are the case: the apps that are still open must be gone first.

A repository **variable**, not a secret: Settings → Secrets and variables → Actions → *Variables* → name `MIN_CLIENT_BUILD`. Its value is the oldest build that may go on running, written as the UTC time of a build, 14 digits: `YYYYMMDDHHmmss`.

1. Publish the app the others must reach, as usual.
2. Read its id: open the published `version.json` in a browser (the address of the app, followed by `version.json`). It shows `{"build":"20261020101500","minBuild":null}`. The value of `build` is the id. GitHub Pages can show the file of the deploy before for some ten minutes: the id is the right one when it is the time of the deploy you just made, in UTC.
3. Set the variable to that id.
4. Actions → the last run of *Deploy to GitHub Pages* → *Re-run all jobs*. The same commit is published again, as a new build, and its `version.json` now carries the minimum. Open it again, ten minutes later: `minBuild` is the id of step 2. If it is still `null`, the run did not see the variable: check its name, and that it is a variable and not a secret, then push the next commit instead — every deploy writes the file.

From then on an app that is open and older than that id fetches the new version at its next return to the foreground (or within the hour), and applies it as soon as nothing is being written, typed or timed — within seconds of the end of a rest, without waiting for the next page. An app that is closed takes the new version when it is opened, as always. Give the open apps a day before the change they must not see.

What it does not do: it does not close an app, and it does not reach a phone that is switched off or without a network. It reloads nothing over a set that is being saved or a message that is being typed.

The variable can stay: it only ever speaks to apps older than its value. To take it back, delete it; the next deploy writes `"minBuild":null`.
````

## docs/RUNBOOK.md — the checkpoint whose sequence publishes the first app of wave 2

Add after the step that pushes to `main`, as what to look at once the run is green:

**The first deploy that keeps the builds before it.** Open the run of *Deploy to GitHub Pages*, job `deploy`, step *This build joins the builds that are published*. This once, its log has the line `adopted    the … files that were published without a record, as the build 00000000000000`: the files of the app that was live are kept, and its open pages go on finding them. Then open the published `version.json` (the address of the app, followed by `version.json`; GitHub Pages can take ten minutes to show it): it names the build and says `"minBuild":null`. Nothing to set — `MIN_CLIENT_BUILD` stays absent until a change to the database needs the open apps gone ([40, section 8](runbook/40-deploy.md)).

What no test can do, on a phone: with the app open on the build before, wait for the deploy, then open a screen that was not opened yet in that session (Stats, Goals). It opens, on the old build or on the new one — never on "Something went wrong".

## CLAUDE.md — Repo map

Replace the two lines that start "                 buildInfo.js (makeBuildId at build time" with:

```
                 buildInfo.js (makeBuildId at build time, BUILD_ID at run time — the id is a
                 <meta> of index.html; buildInfoPlugin also writes version.json { build, minBuild },
                 fetchVersion / isBelowMinimum read it)
                 chunkRecovery.js (isChunkLoadError; createChunkRecovery/chunkRecovery — a page that
                 cannot load one of its files reloads once per build, when nothing would be lost)
                 pendingWrites.js (writesAreSafe — what a reload asked for by a tap waits for)
```

Replace the line that starts "scripts/         check-migrations.mjs (the deploy gate, as a command)" and the line after it with:

```
scripts/         check-migrations.mjs (the deploy gate, as a command) + check-migrations.test.mjs
                 prune-gh-pages.mjs (the tree a deploy publishes: the new build on top of the last
                 ones, as a command) + prune-gh-pages.test.mjs
                 lib/ledger-gate.mjs (what the gate decides and says; opens no connection)
                 lib/published-builds.mjs (which builds stay published and which files go; no git,
                 no network)
```

## CLAUDE.md — Feature → files map, row "App updates (a new version is asked for, waits, and is applied when nothing would be lost)"

Add at the end of the row's file list, before "Tests:":

A build below the oldest one still allowed: `lib/buildInfo` (`VERSION_FILE`, `makeVersion` + `buildInfoPlugin` at build time, `fetchVersion` / `parseVersion` / `isBelowMinimum` at run time), `lib/appUpdate` (`readMinimum` at `start` and in every `check`; `required` → no gap between two questions while no update is pending, and `insist` every `REQUIRED_RETRY_MS`), the repository variable `MIN_CLIENT_BUILD` (`.github/workflows/deploy.yml`, `docs/runbook/40-deploy.md` section 8).

## CLAUDE.md — Feature → files map, new row after "App updates (a new version is asked for, waits, and is applied when nothing would be lost)"

Add the row:

| A page older than the files the server keeps (a screen whose file is gone; what a deploy keeps) | `lib/chunkRecovery` (`isChunkLoadError` — the one definition; `chunkRecovery.install()` on `vite:preloadError`, `recover` — one reload per build id, online, when `appUpdater.busy()` is not `true`; `reloadNow`; `CHUNK_RELOADED_KEY`), `src/main.jsx` (installs it, production builds), `ui/ErrorBoundary` (a chunk-load error is "A new version of the app is available" + "Reload": nothing reported, no "Try again"; "Reload" awaits `lib/pendingWrites` `writesAreSafe`), `lib/errorReporter` (the `unhandledrejection` handler leaves these errors out), strings in the `chunkRecovery` namespace (`lib/i18n/fragments/pwa-chunk-recovery-deploy.<lang>.js`). The deploy: `.github/workflows/deploy.yml` (job `deploy`: "What is published now" → `node scripts/prune-gh-pages.mjs --site published --dist dist` → the action with `publish_dir: ./published`, no `keep_files`; `concurrency` group `publish-site`), `scripts/prune-gh-pages.mjs` (the command), `scripts/lib/published-builds.mjs` (`readDist`, `readSite`, `planSite`, `applyPlan`, `render`; `KEEP_BUILDS`, `ADOPTED_BUILD`, `SiteError`), `builds/<build id>.json` on the `gh-pages` branch. Tests: `lib/chunkRecovery.test.js`, `ui/ErrorBoundary.test.jsx`, `lib/errorReporter.test.js`, `src/main.test.jsx`, `scripts/prune-gh-pages.test.mjs`, `src/test/ciGuardrails.test.js` (the steps of the job, the step that reads the branch run against a repository, `version.json` out of the precache) |

## CLAUDE.md — Feature → files map, row "CI & deploys"

Replace "`.github/workflows/deploy.yml` (gh-pages publish behind two gates: the reusable test workflow, then the `migrations` job of the next row)" with:

`.github/workflows/deploy.yml` (gh-pages publish behind two gates: the reusable test workflow, then the `migrations` job of the next row; the publish itself adds the build to the last ones — row "A page older than the files the server keeps")

## CLAUDE.md — Commands

Add after the line that starts "node scripts/check-migrations.mjs --print":

```bash
node scripts/prune-gh-pages.mjs --site <a copy of the published tree> --dist dist --dry-run   # what a deploy of this build would keep and delete; writes nothing
```

## CLAUDE.md — When you add a feature

Add to item 3, after the bullet that starts "A new route or redirect gets a row":

   - Code that reloads the page asks `appUpdater.busy()` first (`lib/appUpdate`), or is a tap: a reload lands on whatever is being written, typed or timed. A new wording of "this file did not load" joins `NOT_LOADED` in `lib/chunkRecovery`, never a second test of the message.
