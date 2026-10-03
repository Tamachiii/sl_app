# w0-tooling-guardrails — docs to fold (wave 0, items B17, B1)

Each block: target doc, section, then the text to fold in.

## CLAUDE.md — Commands

Replace the lint line and add the audit line:

```bash
npm run lint      # eslint with a warning ceiling (--max-warnings 26): one NEW warning fails the gate
npm audit --omit=dev --audit-level=high   # what CI runs after the install; must print "found 0 vulnerabilities"
```

Under the block: the ceiling is a ratchet. Lower the number in `package.json` when a warning is fixed; never raise it. A new warning is fixed, or disabled inline with the reason.

## CLAUDE.md — Feature → files map, row "CI & deploys"

`.github/workflows/test.yml` (reusable gate, three jobs: `test` = install, production audit, lint with its ceiling, unit suite, build; `db` = `npm run test:db`; `functions` = `deno check` over `supabase/functions/*/index.ts`), `.github/workflows/deploy.yml` (test-gated gh-pages publish), `.github/workflows/backup.yml`, `eslint.config.js`, `src/test/ciGuardrails.test.js` (static guards over the three workflows and the lint script), `src/routes.test.jsx` (the whole route table against the installed router).

## CLAUDE.md — When you add a feature

- A new Edge Function is a directory under `supabase/functions/` with an `index.ts`; shared modules live in a directory whose name starts with `_`. `src/test/ciGuardrails.test.js` fails otherwise, because the CI glob would skip the function.
- A new route or redirect gets a row in `src/routes.test.jsx`.
- Dependencies change only in wave 0 and wave 9. `@fontsource-variable/inter`, `@fontsource-variable/archivo`, `@fontsource-variable/jetbrains-mono` and `axe-core` are installed and not yet imported.

## README.md — commands block and the Tests paragraph

- `npm run lint` comment: "eslint, correctness-only, with a warning ceiling of 26; also runs in CI".
- Test counts: 84 files / 913 tests at the end of this package (was 82 / 854): `src/routes.test.jsx` (44) and `src/test/ciGuardrails.test.js` (15).
- CI sentence: the gate also refuses a high or critical advisory in a runtime dependency (`npm audit --omit=dev --audit-level=high`) and type-checks the Edge Functions (advisory until its first green run).

## docs/RUNBOOK.md — first-push checklist

None of this can run before the first push; check it on the first CI run.

1. `test` job, step `npm audit --omit=dev --audit-level=high`: green. If red with an unchanged lockfile, a new advisory was published: run `npm audit --omit=dev` locally, then `npm audit fix` (never `--force`), run the suite, commit the lockfile.
2. The three pinned actions resolve (a wrong SHA fails the job at "Set up job"):
   - `peaceiris/actions-gh-pages@84c30a85c19949d7eee79c4ff27748b70285e453` (v4.1.0) in `deploy.yml`
   - `supabase/setup-cli@1dedf2c611547ede7232d26866dd3c56ab903bbb` (v1.7.3) in `backup.yml` — run the backup once by hand (Actions → Nightly DB backup → Run workflow)
   - `denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed` (v2.0.5) in `test.yml`
3. `functions` job: the `deno check` step is green (no "Edge Functions" warning on the run summary). Then delete `continue-on-error: true` and the reporting step after it in `test.yml`, so a broken function stops the gate from then on.

## docs/RUNBOOK.md (or docs/runbook/40-deploy.md) — updating a pinned action

```bash
git ls-remote https://github.com/<owner>/<repo> 'refs/tags/v<major>*'
```

Take the commit of the release you want (for an annotated tag, the line ending in `^{}`), paste the 40 characters after the `@`, and update the `# vX.Y.Z` comment on the same line. `src/test/ciGuardrails.test.js` refuses a tag, a branch, a short SHA, or a SHA without its release comment.

## docs/RUNBOOK.md — known open advisory (dev only)

`npm audit` (without `--omit=dev`) reports 5 highs, all one chain: `braces` (GHSA-vfj7-8cjw-p6xm, every version) through `micromatch`, `fast-glob`, `globby`, `gh-pages`. There is no fixed release; the only thing npm offers is `--force`, a downgrade to `gh-pages` 6.1.1. Do not run it. `gh-pages` is a devDependency used only by the emergency `npm run deploy`, so the production audit in CI is unaffected.
