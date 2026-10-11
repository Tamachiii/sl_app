# ci-deploy-ledger-gate — docs to fold (wave 1, items P69)

Each block: target doc, section, then the text to fold in. `docs/runbook/40-deploy.md` and the two sentences of `BACKUPS.md` (section *The nightly run on GitHub*) were written directly by the package and are current.

## docs/RUNBOOK.md — the table of pages under the first paragraph

Add after the row that starts "| [runbook/20-auth-config.md]":

| [runbook/40-deploy.md](runbook/40-deploy.md) | publishing the app: what a push to `main` runs, the check of the ledger that stops it, the secret it reads production with, what each refusal means |

## docs/RUNBOOK.md — Rules that hold at every checkpoint

Add at the end of rule 6, after "the repository is public ([First-push checklist](#first-push-checklist)).":

The deploy holds this rule itself: between the tests and the publish, its `migrations` job reads the ledger and stops when a `required` migration of the commit is not in it, naming each one ([runbook/40-deploy.md](runbook/40-deploy.md)). It is the net, not the plan: the checkpoint still comes first. `npm run deploy`, the emergency publish from your machine, goes around it.

## docs/RUNBOOK.md — Checkpoints

Replace, in the row of A3, the cell "after the push: the two secrets of the nightly backup" with:

just before the push: the two repository secrets — the deploy reads the ledger with `SUPABASE_DB_URL`, and stops without it

## docs/RUNBOOK.md — First-push checklist

Add before the sentence that starts "Nothing is pushed while the review is being worked through":

**Before the push: the two repository secrets.** Settings → Secrets and variables → Actions: `SUPABASE_DB_URL`, the session-pooler connection string of the project with the database password in it, and `BACKUP_PASSPHRASE`, the passphrase of your `.env`. [BACKUPS.md](../BACKUPS.md), section *The nightly run on GitHub*, says where each comes from — and what it means that the first is the connection string of the `postgres` role. The deploy that the push starts reads the ledger with the first one and publishes nothing without it; the nightly backup needs both. Set them the day of the push, not earlier: until then `main` carries the previous backup workflow. Then ask the question the deploy will ask, on the commit you are about to push ([runbook/40-deploy.md](runbook/40-deploy.md), section 2); `OK` is the only ending after which you push.

Add as the first item of the numbered list (the others move down by one):

1. Job `migrations`: green. Its log ends with `OK: production has all … required migrations of this commit. The deploy can go on.` and shows the user `postgres.<project ref>` it connected as. Red: nothing was published, and the last lines of the job say which case it is — [runbook/40-deploy.md](runbook/40-deploy.md), section 4. This job has never run on GitHub: the pooler and its TLS are new to it, as they were to the backup script. If it stays red although the ledger is complete — you have read it yourself — section 5 of that page says how to publish without the check.

Replace, in the item that starts "**The nightly backup.**", the bullet that starts "set the two repository secrets (Settings → Secrets and variables → Actions)" with:

   - the two repository secrets are set — the step before the push, above;

## README.md — Deployment

Replace the paragraph that starts "Pushing to `main` deploys automatically:" with:

Pushing to `main` deploys automatically. `.github/workflows/deploy.yml` runs three jobs, each waiting for the one before it: the full test suite (the reusable `test.yml`, which also runs on every `dev` push / PR); then `migrations`, which reads the list of applied migrations in production (`app_private.app_migrations`) and stops the deploy when a `required` migration of `supabase/migrations/manifest.json` is missing; and only then the build and the publish of `dist/` to the `gh-pages` branch. What the check needs, what each refusal means and how to re-run it: [docs/runbook/40-deploy.md](docs/runbook/40-deploy.md). Vite `base` is `/sl_app/`; the router uses `HashRouter` so deep links survive static hosting.

Replace the paragraph that starts "Supabase env vars are passed in at build time" with:

Supabase env vars are passed in at build time — ensure GitHub Actions secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_VAPID_PUBLIC_KEY` are set. The `migrations` job needs a fourth secret, `SUPABASE_DB_URL` (the one the nightly backup reads): without it the deploy stops, unless the repository variable `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK` is `true`.

Replace the paragraph that starts "`npm run deploy` still exists as an emergency-only manual path" with:

`npm run deploy` still exists as an emergency-only manual path — it publishes whatever is in the local working tree and goes around both gates, the tests and the check of the ledger, so prefer the Actions pipeline. Before it, the owner runs the check by hand: `node --env-file=.env scripts/check-migrations.mjs --verify`.

## README.md — Directory Structure

Add after the line that starts "  tests/               Database suite":

```
scripts/
  check-migrations.mjs The deploy gate: production's ledger against manifest.json (docs/runbook/40-deploy.md)
```

## README.md — Database Tests

Add after the bullet that starts "`auth-accounts.test.js` runs the account list":

- `deploy-gate.test.js` runs the deploy gate (`scripts/check-migrations.mjs --verify`) as a child process against databases in the states production can be in: everything applied, one migration off the record, an empty ledger, no ledger at all, and the frozen baseline with the `required` migrations applied one file at a time — the gate opens after the last one and not before. It also holds what the gate must not take for an answer: a role that may not read the ledger, a ledger that row-level security filters, a password the database refuses. The commands of `docs/runbook/40-deploy.md` are read off the page and run. It creates two login roles in the cluster and drops them at the end.

## README.md — Testing Conventions

Replace "the three workflows and the lint script (`src/test/ciGuardrails.test.js`)" with:

the three workflows and the lint script (`src/test/ciGuardrails.test.js`), the deploy gate on a stubbed ledger (`scripts/check-migrations.test.mjs`)

## CLAUDE.md — Repo map

Add after the line that starts "                 fixtures/prod_baseline_2026_09_30.sql":

```
scripts/         check-migrations.mjs (the deploy gate, as a command) + check-migrations.test.mjs
                 lib/ledger-gate.mjs (what the gate decides and says; opens no connection)
```

## CLAUDE.md — Feature → files map, row "CI & deploys"

Replace "`.github/workflows/deploy.yml` (test-gated gh-pages publish)" with:

`.github/workflows/deploy.yml` (gh-pages publish behind two gates: the reusable test workflow, then the `migrations` job of the next row)

Add after the row "CI & deploys":

| Deploy gate on the ledger (a push to `main` publishes only when production has every `required` migration of the commit) | `.github/workflows/deploy.yml` (job `migrations`, between `test` and `deploy`: one step, `node scripts/check-migrations.mjs --verify`, with the secret `SUPABASE_DB_URL` and the variable `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`; read-only token, `npm ci --ignore-scripts`), `scripts/check-migrations.mjs` (the command: `--print` connects to nothing, `--verify` exits 1 when a `required` migration is not in `app_private.app_migrations` **or the ledger could not be read**; `optional` and `contract` are never asked for), `scripts/lib/ledger-gate.mjs` (`manifestFaults`, `compare`, `readLedger` — one read-only transaction, refuses a role that cannot read the table or that row-level security filters — `decide`, `render`; the override stands in for a secret that is NOT SET and for nothing else), `scripts/backup/lib/connection.mjs` (the connection, shared with the backup), `docs/runbook/40-deploy.md` (the owner's page; the messages it quotes are held to what the command prints), tests `scripts/check-migrations.test.mjs` (stubbed ledger), `supabase/tests/deploy-gate.test.js` (the command against the embedded PostgreSQL), `src/test/ciGuardrails.test.js` (the workflow cannot go around the job: no `if:`, no `continue-on-error`, one publish, the database URL in one step) |

## CLAUDE.md — Commands

Replace "npm run deploy    # emergency-only manual publish — bypasses the CI test gate." with:

npm run deploy    # emergency-only manual publish — bypasses the CI test gate AND the ledger check.

Add after the line that starts "npm run test:docs":

```
node scripts/check-migrations.mjs --print   # the migrations of this checkout, which ones a deploy needs, and the query that reads the ledger; connects to nothing
```

## CLAUDE.md — When you add a feature

Add at the end of step 2, after "the user does, following `docs/RUNBOOK.md`.":

The `kind` of the manifest entry is what the deploy goes by: every `required` migration of a commit must be in production's ledger before the app of that commit is published (`scripts/check-migrations.mjs`, run by `deploy.yml`), so `required` means "the client of this wave breaks without it" — a migration the client can live without is `optional`. An agent never runs `scripts/check-migrations.mjs --verify` with the owner's `.env`: it connects to production. `--print` connects to nothing.

## docs/ARCHITECTURE.md — Migrations and the ledger

Add after the paragraph that starts "**The hand-over.**":

**The deploy gate.** A push to `main` publishes the app, and the SQL that app needs is applied by hand, so `.github/workflows/deploy.yml` has a job between the tests and the publish: `migrations` runs `node scripts/check-migrations.mjs --verify`, which reads `app_private.app_migrations` in one read-only transaction and compares names with `supabase/migrations/manifest.json` of the commit being deployed. A `required` migration that is not in the ledger stops the deploy and is named with its checkpoint and its page; `optional` and `contract` entries are not asked for; a name the ledger has and the commit does not is noted and does not stop anything (an older commit put back). The check fails closed: when the ledger cannot be read — no secret, a refused password, a role without `USAGE` on `app_private` and `SELECT` on the table, a table that row-level security filters for that role — the answer is no, because an unread ledger and an empty one must not look alike. One exception: with no `SUPABASE_DB_URL` at all and the repository variable `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK` exactly `true`, the job is green without reading anything and leaves a warning on the run. That variable never lifts a migration found missing, nor a secret that is set and does not work. `scripts/lib/ledger-gate.mjs` holds the decision and its wording and opens no connection; the command around it connects the way the backup does (`scripts/backup/lib/connection.mjs`). The secret stays in the environment of that one step, in a job without a write token where no install script runs — never in the job that builds and publishes. [runbook/40-deploy.md](runbook/40-deploy.md) is the owner's page.

## docs/ENVIRONMENT.md — new section "GitHub Actions: secrets and variables", after "Supabase Auth settings (production)"

Add:

````markdown
## GitHub Actions: secrets and variables

Repository settings → Secrets and variables → Actions. A secret cannot be read back; a variable can.

| Name | Kind | Read by | What it is |
|---|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | secret | the build of `deploy.yml` | the project URL and its anon key, as in `.env` |
| `VITE_VAPID_PUBLIC_KEY` | secret | the build of `deploy.yml` | the public Web Push key; without it the push toggles say "not supported" |
| `SUPABASE_DB_URL` | secret | the `migrations` job of `deploy.yml`, and `backup.yml` | the session-pooler connection string of the project, with the database password — the `postgres` role. `BACKUPS.md`, section *The nightly run on GitHub* |
| `BACKUP_PASSPHRASE` | secret | `backup.yml` | the passphrase a backup is encrypted with |
| `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK` | variable | the `migrations` job of `deploy.yml` | normally absent. `true` lets a deploy go out unchecked while `SUPABASE_DB_URL` is not set: [runbook/40-deploy.md](runbook/40-deploy.md), section 5 |

Without `SUPABASE_DB_URL` a push to `main` publishes nothing: the deploy stops at `migrations`.
````
