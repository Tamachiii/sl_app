# sql-01b-auth-config-handoff — docs to fold (wave 0, items L5)

Each block: target doc, section, then the text to fold in.

## docs/ENVIRONMENT.md — new section "Supabase Auth settings (production)", after "Gotchas"

Add:

````markdown
## Supabase Auth settings (production)

These live in the Supabase dashboard and nowhere else. The project's owner sets them by hand, following [runbook/20-auth-config.md](runbook/20-auth-config.md) — the steps, the read-only check, and what to leave alone. The repository holds no copy that could be pushed: `supabase/config.toml` carries the Edge Function flags only, and `supabase config push` is never run, because for every setting the file does not give it would put the CLI's default back (sign-up on, site URL on localhost, 6-character passwords).

The values production must have:

| Setting (API name) | In the dashboard, under Authentication | Value |
|---|---|---|
| `disable_signup` | Sign In / Providers → Allow new users to sign up | `true` (the switch is off) |
| `site_url` | URL Configuration → Site URL | `https://tamachiii.github.io/sl_app/` |
| `uri_allow_list` | URL Configuration → Redirect URLs | `https://tamachiii.github.io/sl_app/**`, and nothing else |
| `password_min_length` | Sign In / Providers → Email → Minimum password length | `8` — what the app's change-password dialog asks for |

Settings that stay as they are, because the app that is deployed depends on them:

| Setting (API name) | Value | Why |
|---|---|---|
| Email provider | on | switched off, nobody can sign in |
| `mailer_autoconfirm` (Confirm email) | `false` (the switch is on) | an address is confirmed before its first sign-in |
| Anonymous sign-ins | off | every account has an e-mail address |
| `security_captcha_enabled` | `false` | sign-in sends no captcha answer |
| `security_update_password_require_reauthentication` (Secure password change) | `false` | the change-password dialog sends no re-authentication code |
| `password_required_characters` | none | the app checks the length only |
| `password_hibp_enabled` (leaked-password protection) | `false` | paid plan only; the project is on the free plan |
| Custom SMTP | none (built-in sender, `rate_limit_email_sent` = 2 per hour) | nothing sends e-mail before the invitation flow |

Accounts are created in the dashboard (Authentication → Users → Add user). The app has no sign-up screen.

To read them: the check of the runbook page prints `disable_signup`, `mailer_autoconfirm` and the enabled providers from the public `/auth/v1/settings`. The other values are visible in the dashboard only.
````

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Signups are always `role='student'`**":

- **Public sign-up is off, and only the dashboard holds that setting.** The app is invite-only: it has no sign-up screen, nothing in `src/` calls `signUp`, and accounts are created in the Supabase dashboard. `disable_signup = true` — with the site URL, the redirect list and the 8-character minimum listed in `docs/ENVIRONMENT.md` — is set by hand by the project's owner, following `docs/runbook/20-auth-config.md`. No code can enforce it, so nothing in the repository may undo it: `supabase/config.toml` carries `[functions.<name>]` tables and nothing else, and no script or workflow runs `supabase config push`, which would overwrite the remote Auth settings with the CLI's defaults (sign-up on, site URL on localhost, 6-character passwords). `src/test/authConfig.test.js` holds both, and runs the page's read-only check of `/auth/v1/settings`, read off the page, against a stand-in server. Do not "harden" Auth in the dashboard without the client change that goes with it: captcha and "Secure password change" both lock users out of the deployed app (sign-in sends no captcha answer, the change-password dialog sends no re-authentication code).

## README.md — Deployment

Replace "If the app is invite-only (it currently is), also disable public email signups under Supabase → Auth → Providers." with:

The app is invite-only: public sign-up is off in the Supabase dashboard, and accounts are created there. That setting and the other Auth settings production must have are listed in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md); the steps and the check are in [docs/runbook/20-auth-config.md](docs/runbook/20-auth-config.md). They are set by hand and never pushed from the repository (`supabase config push` is forbidden).

## CLAUDE.md — Feature → files map, new row after "Auth / login"

Add:

| Supabase Auth settings (dashboard-only: sign-up off, site URL, redirect list, password length) | `docs/runbook/20-auth-config.md` (the owner's steps, the read-only check of `/auth/v1/settings`, the list of accounts, what to leave alone), `docs/ENVIRONMENT.md` (the values), `src/test/authConfig.test.js` (the page's check run against a stand-in server; `supabase/config.toml` carries function flags only; nothing runs `supabase config push`), `supabase/tests/auth-accounts.test.js` (the page's account query on forged and self-made accounts) |

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add at the end of the row's file list:

`auth-accounts.test.js` (the "who has an account" query of `docs/runbook/20-auth-config.md`, read off the page: a clean project, an account made through the open sign-up, a forged coach link, an account without a profile; read-only, and refused to `anon` and `authenticated`).

## CLAUDE.md — When you add a feature

Add as a new bullet at the end of the list:

- A command or a query that a runbook page asks the owner to run is tested by reading it off the page (`src/test/authConfig.test.js`, `supabase/tests/auth-accounts.test.js`, `supabase/tests/rpc-auth.test.js`). Changing the command means changing the page, and the test follows the page.

## README.md — Database Tests

Add after the bullet that starts "`rpc-auth.test.js` calls the five coach-only" (the `sql-01-rpc-null-guard` snippet adds it):

- `auth-accounts.test.js` runs the account list of `docs/runbook/20-auth-config.md` — the query is read off the page — on the accounts an open sign-up leaves behind.

## README.md — commands block and the Tests paragraph

Test counts: this package adds one file and 11 tests to the unit suite (`src/test/authConfig.test.js`) and one file and 9 tests to the database suite (`supabase/tests/auth-accounts.test.js`, which makes 10 files, 218 tests and 7 expected failures).

## docs/RUNBOOK.md — Checkpoint A0

The Auth steps are `docs/runbook/20-auth-config.md`. They need no migration and can be done before, between or after migrations 01 and 02. In order: the check (it prints `disable_signup: false`), the list of accounts (one read-only query; an address the owner does not know is reported, not deleted), the four settings in the dashboard (sign-up off, site URL, one redirect URL, minimum password length 8), the check again (`disable_signup: true`), then a sign-in in a private window.

The check reads `/auth/v1/settings`, which shows `disable_signup` only: the site URL, the redirect list and the password length are confirmed by reloading the dashboard pages.

Two things are not steps: leaked-password protection (paid plan only — the Security Advisor keeps that warning) and a custom SMTP sender (needed from wave 6).

The page also lists four dashboard switches that look like hardening and lock everyone out of the deployed app (the Email provider, captcha, "Secure password change", password requirements). Hand that warning over with the checkpoint.

## docs/RUNBOOK.md — rules that hold at every checkpoint

`supabase config push` is never run, and `supabase/config.toml` never gets an `[auth]` section: a push would put the CLI's Auth defaults back (sign-up on, site URL on localhost, 6-character passwords). `docs/runbook/20-auth-config.md` and `docs/runbook/00-before-you-start.md` both say so; `src/test/authConfig.test.js` holds the repository's side.
