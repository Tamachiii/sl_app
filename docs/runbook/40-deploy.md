# 40 — Publishing the app: the deploy and its gate

This page is for the person who pushes to `main`. A push to `main` publishes the app: `.github/workflows/deploy.yml` runs, and what it builds replaces what every athlete has installed the next time their phone checks.

The app of a commit and the SQL of that commit belong together. The app calls the functions and reads the columns its migrations add, and you apply those migrations to production by hand ([00](00-before-you-start.md)). **Database first, app second**: every `required` migration of a commit is in production before the app of that commit is published.

Until October 2026 that was a rule on a page. The deploy now checks it, and stops when it does not hold.

## 1. What a push to `main` runs

| Job | What it does | Red means |
|---|---|---|
| `test` | lint, the unit tests, the database tests, the audit of what ships | the code is not fit to publish |
| `migrations` | reads the ledger of production and compares it with `supabase/migrations/manifest.json` | **production does not have what this app needs — or nobody could tell** |
| `deploy` | builds with the real keys, adds the build to what is published — the files of the two builds before it stay — and publishes to GitHub Pages | the build, the preparation of the published tree or the upload failed: section 8 |

Each one waits for the one before it. Nothing is published unless the first two are green.

The `migrations` job runs one command, `node scripts/check-migrations.mjs --verify`. It opens one read-only transaction, reads `app_private.app_migrations` — the ledger, where every migration writes its own name when it is applied — and compares names:

- a **`required`** migration of the manifest that is not in the ledger stops the deploy, and is named;
- an `optional` one is not asked for: it may be skipped by design;
- a `contract` one is not asked for either: it is applied long after the deploy, at Checkpoint Z.

It reads no table of the app and cannot change anything.

What it does not check: that the SQL behind a name in the ledger still is what its file says (the ledger is a list of names), that the Edge Functions are deployed, or any dashboard setting. Those stay steps of the checkpoints in [RUNBOOK.md](../RUNBOOK.md).

## 2. Before you push to `main`

Ask the same question yourself first. It is the command the deploy runs. On your machine it connects the way the backup does ([00, section 2](00-before-you-start.md)): the database password of `.env`, and the address the linked CLI keeps.

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

It prints who it connects as and where — `postgres.<project ref> at …pooler.supabase.com`: the ref is how you see it is the right project — then one line per migration of the checkout:

```text
  NN  migration                               kind      checkpoint  production
  01  2026_10_03_01_migration_ledger          required  A0          applied 2026-10-12 08:01 UTC
  02  2026_10_03_02_rpc_auth_null_guard       required  A0          applied 2026-10-12 08:03 UTC
  03  2026_10_11_03_function_grants_lockdown  required  A1          MISSING
```

It ends with `OK: production has all … required migrations of this commit. The deploy can go on.` — or with `REFUSED:` and the list of what is missing, each with its checkpoint and its page. `OK` is the only ending after which you push.

Run it on the commit you are about to push: the list is the `manifest.json` of the checkout.

This one connects to nothing. It lists what the commit needs and gives the query that reads the ledger by hand:

```bash
node scripts/check-migrations.mjs --print
```

## 3. Once: the secret the deploy reads production with

The `migrations` job needs the repository secret `SUPABASE_DB_URL`. It is the secret of the nightly backup: one value serves both. What it is, where it comes from, and what it means that it is the connection string of the `postgres` role: [BACKUPS.md](../../BACKUPS.md), section *The nightly run on GitHub*. Set it together with `BACKUP_PASSPHRASE`, as that section says: Settings → Secrets and variables → Actions → *Secrets*.

**When: the day of the first push to `main`, just before the push.** A secret can be set before the workflow that reads it exists. Not days earlier: until the push, `main` carries the previous backup workflow, which would use the secret that night for a command BACKUPS.md no longer describes.

If you pushed first, nothing is lost and nothing was published: the `migrations` job of that run is red with `SUPABASE_DB_URL is not set`. Set the two secrets, then re-run the job (section 4).

## 4. When the `migrations` job is red

Nothing was published: the app that was live is still live. Open the job; the last lines say which case it is.

| The message starts with | It means | Do |
|---|---|---|
| `REFUSED: … not applied in production` | the app of this commit is ahead of the database | apply the migrations it lists, in order, each at its checkpoint ([RUNBOOK.md](../RUNBOOK.md)), then re-run. When it adds `Production has no ledger at all`, migration 01 itself is missing: Checkpoint A0 |
| `REFUSED: the ledger of production was not read — SUPABASE_DB_URL is not set` | the secret does not exist | section 3 — or section 5 |
| `REFUSED: the ledger of production could not be read.` | the secret is set and did not work; the line under it says why | the next table |
| `REFUSED: supabase/migrations/manifest.json cannot be judged` | a fault of the repository, not of production | nothing to apply. Stop and report the message |
| `FAILED:` | the check itself broke | stop and report the message |

**Could not be read**, by what the line under it says. Whatever it says, look at the project in the dashboard first: a free-plan project that has been paused answers no connection until it is restored.

| It says | Do |
|---|---|
| `password authentication failed`, code `28P01` | the password inside `SUPABASE_DB_URL` is not the database password. Set the secret again (BACKUPS.md). Inside a URL, a password with characters other than letters, digits, `-`, `.`, `_` and `~` is percent-encoded |
| `is not a PostgreSQL connection URL` | the same: the secret is not a whole connection string, or its password is not percent-encoded |
| `ENETUNREACH` or `ENOTFOUND` | the address is not the session pooler's. `db.<ref>.supabase.co` answers over IPv6 only, which a GitHub runner does not have: take the string of Dashboard → Connect → Session pooler |
| `Tenant or user not found` | the pooler does not know the project named in the user (`postgres.<project ref>`), or it is the pooler of another region. Copy the string again from Dashboard → Connect → Session pooler |
| `ECONNREFUSED`, `ETIMEDOUT`, `timeout` | the database did not answer in time. Re-run |
| `Role … may not read app_private.app_migrations` | the connection string is not the one of the `postgres` role |
| `Row-level security is on for app_private.app_migrations` | somebody enabled row-level security on the ledger, which must not have it. Stop and report |

**Re-run.** Actions → the red run → *Re-run failed jobs*. The run keeps its commit, so no new commit is needed: the tests are not run again, the check is, and the deploy follows when the check is green.

## 5. Publishing while the secret is not set: `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`

A repository **variable**, not a secret: Settings → Secrets and variables → Actions → *Variables* → name `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`, value `true`. That exact word: `True`, `1` or `yes` leave the deploy stopped.

With it, and with no `SUPABASE_DB_URL`, the `migrations` job is green without having read anything. It prints `NOT CHECKED`, lists what the commit needs, and leaves a warning on the run. From then on the rule of this page is kept by hand: before each push, read the ledger and compare it with the list of `--print` (section 2) —

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

What the variable does **not** do:

- It does not lift a migration that was found missing. Once the secret is set the check runs, whatever the variable says.
- It does not lift a secret that is set and does not work (section 4). Fix the secret. If it cannot be fixed that day, the way out is to delete the secret: the variable then applies — and the nightly backup, which reads the same secret, is red until the secret is back.

Delete the variable the day the secret is set. A run that checked and still found the variable says so in a warning.

## 6. The emergency publish

`npm run deploy` builds on your machine and publishes from there. It goes around **both** gates: the tests and this one. So the check comes first, by hand, and `OK` is the only ending after which you publish:

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

It also replaces everything that is published with the build of your machine. The files of the builds before it are gone, and so are the records the deploy keeps of them (section 8). An app that was open since before then reloads by itself the next time it opens a screen it had not opened yet, or shows "A new version of the app is available" with a "Reload"; nothing is lost. The next deploy from `main` takes what it finds as one old build and keeps it like any other.

## 7. Putting an older app back

`git revert` on `main`, or *Re-run all jobs* on the run of an older commit, publishes the app of that commit again (BACKUPS.md, *Rollback of the app*). When that commit carries this gate, the check runs then too, with the manifest of the commit being published. An older commit needs fewer migrations than production has: the check notes the others (`the ledger also lists …`) and does not stop for them — every migration is written to be safe under the app that was live before it.

The app that is put back is a new build: it gets a new id (the time of its build) and goes on top of the builds that are published, like any deploy. `MIN_CLIENT_BUILD` (section 8) does not stand in its way — a minimum is a time, and this build is made now.

One limit the check does not know: the `contract` migrations of Checkpoint Z remove what old apps still use. After Checkpoint Z, an app from before the last wave cannot be put back.

One thing the devices do after it: an app from before the update flow (before wave 2) takes over on every device by itself, as it always did — but the deploy that follows it does not. Its service worker waits to be asked by the page, and the pages of the older app cannot ask. On a device that had already run a wave-2 app, that next deploy arrives when the app is closed and opened again (on a phone: swiped away, or after the system has put it to sleep), not on a reload. Nothing is lost meanwhile; the device simply stays on the older app until then.

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
