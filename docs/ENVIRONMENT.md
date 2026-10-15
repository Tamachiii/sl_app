# Environment

`sl_app` is a **Pure-WSL** project. Do all development — Claude Code sessions, `npm` commands, git operations — from inside the Ubuntu WSL distro, not from Windows against a WSL checkout. Running Claude Code from Windows over a `\\wsl.localhost\...` UNC path appears to work but introduces a long tail of friction: the git worktree `.git` file points at UNC paths, `.env` doesn't propagate into new worktrees, git identity must be re-set, and CRLF slips in through editors that don't honor `.gitattributes`. None of those problems exist if the tool and the checkout live on the same filesystem.

## One-time setup

1. **Install Claude Code inside WSL** (not Windows).
   ```bash
   # inside WSL
   npm install -g @anthropic-ai/claude-code
   ```

2. **Set your git identity inside WSL** — commits from the Windows-side Claude use Windows git config; they don't carry over.
   ```bash
   git config --global user.email "you@example.com"
   git config --global user.name  "Your Name"
   ```

3. **Use Node 20** to match CI. [.nvmrc](../.nvmrc) pins it.
   ```bash
   nvm use
   # or, first time:
   nvm install 20 && nvm use 20
   ```

4. **VS Code** (optional): use the **Remote-WSL** extension and "Open Folder in WSL" at `/home/tamachi/sl_app`. Don't open the UNC path from Windows VS Code.

## Daily flow

Open the project by launching Claude Code from a WSL shell:

```bash
wsl -d Ubuntu
cd /home/tamachi/sl_app
claude
```

The cwd becomes the Linux path, and everything Claude spawns inherits it. No `wsl -d Ubuntu -- bash -lc "cd ..."` incantations.

Tests and builds run directly:

```bash
npm test -- --run     # the unit suite, single pass
npm run build         # production build → dist/
npm run dev           # vite on port 5173
```

## Creating a new worktree

Do this **from inside WSL** so the worktree's `.git` gitdir is a native Linux path:

```bash
cd /home/tamachi/sl_app
git worktree add ../sl_app_wt_featurename -b feature/name
cd ../sl_app_wt_featurename
ln -s /home/tamachi/sl_app/.env .env   # Supabase keys propagate
```

Verify the worktree is wired correctly:

```bash
cat .git
# → gitdir: /home/tamachi/sl_app/.git/worktrees/sl_app_wt_featurename
```

If you see `gitdir: //wsl.localhost/...` instead, the worktree was created from Windows — delete it and recreate from inside WSL.

Clean up when done:

```bash
git worktree remove ../sl_app_wt_featurename
```

## Why these files exist

- **[.gitattributes](../.gitattributes)** — `* text=auto eol=lf` so line endings stay LF regardless of which OS or editor checks out the tree. Prevents mixed-CRLF commits if someone opens the repo from Windows.
- **[.nvmrc](../.nvmrc)** — pins Node 20 to match `.github/workflows/*` (runs on `ubuntu-latest` with Node 20). `nvm use` in the repo root picks it up.
- **[.claude/launch.json](../.claude/launch.json)** — wraps `npm run dev` in `wsl -d Ubuntu -- bash -lc`. The wrapper is required while Claude Code is running on the Windows side (a bare `"runtimeExecutable": "npm"` fails with `spawn npm ENOENT` because Windows needs `npm.cmd`). The hardcoded `cd /home/tamachi/sl_app` was dropped — `wsl.exe` translates the worktree's Windows cwd into the matching Linux path before invoking bash, so the config is worktree-agnostic. Once Claude Code itself runs inside WSL (the goal of this migration), the wrapper can be replaced with `"runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"]`.

## Gotchas

- **Don't edit files through `\\wsl.localhost\...` from a Windows editor mid-session.** Mixed access paths confuse file watchers (Vite HMR, Vitest) and can leave a second scrollbar in the `node_modules` state.
- **Don't create worktrees from Windows** (`git worktree add` from `\\wsl.localhost\...`). The gitdir stays UNC and every subsequent `git` call in that worktree is slower.
- **The `.env` symlink is required per-worktree.** Without it, Supabase calls fail at runtime with "supabaseUrl is required" — Vite reads `.env` from the project root only.
- **GitHub CLI auth lives per OS.** If you had `gh auth login` set up on Windows, run it again inside WSL.

## Supabase Auth settings (production)

These live in the Supabase dashboard and nowhere else. The project's owner sets them by hand, following [runbook/20-auth-config.md](runbook/20-auth-config.md) — the steps, the read-only check, and what to leave alone; it is the third part of Checkpoint A0 in [RUNBOOK.md](RUNBOOK.md). The repository holds no copy that could be pushed: `supabase/config.toml` carries the Edge Functions' flags only, and `supabase config push` is never run, because for every setting the file does not give it would put the CLI's default back (sign-up on, site URL on localhost, 6-character passwords).

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

To read them: the check of the runbook page prints `disable_signup`, `mailer_autoconfirm` and the enabled providers from the public `/auth/v1/settings`. The other values are visible in the dashboard only. `src/test/runbookIndex.test.js` keeps the three values that are written here, on the runbook page and in the index the same.

## Supabase API settings (production)

| Setting | In the dashboard | Value |
|---|---|---|
| Max rows (`db-max-rows`) | Project Settings → Data API → Settings → Max rows | `1000` — the default. It may be raised, never lowered below `PAGE_SIZE` in `src/lib/supabasePaging.js` |

The app reads long lists a page of 1000 at a time and takes a page shorter than that for the end. With a lower Max rows every page is short, and stats, records and "Last time" are silently cut again.

## Edge Function secrets (production)

Set by hand by the project's owner, following [runbook/30-edge-functions.md](runbook/30-edge-functions.md). No file of the repository holds a value, and `.env` holds none of them.

The functions' secrets (`supabase secrets set`, read as environment variables):

| Name | Read by | What it is |
|---|---|---|
| `INTERNAL_BEARER` | `send-push`, `dispatch-rest-push` | the secret the database presents to `send-push`, and the one `dispatch-rest-push` shows itself from one minute of a rest to the next (header `x-internal-bearer`); a random string (`openssl rand -hex 32`), not the service-role key |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `send-push`, `dispatch-rest-push` | the pair that signs every push; the public half is also `VITE_VAPID_PUBLIC_KEY` at build time |
| `VAPID_SUBJECT` | `send-push`, `dispatch-rest-push` | a `mailto:` address |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase.

The database's vault (read by the notification triggers):

| Name | What it is |
|---|---|
| `app_functions_url` | `https://<project ref>.supabase.co/functions/v1` |
| `app_service_role_key` | the same value as `INTERNAL_BEARER` (the name is historical: it is not the service-role key) |
| `app_internal_bearer` | the same secret under its own name, once the owner has renamed it — optional, `docs/runbook/migrations/15-push-plumbing.md` |

Since migration 15 one function reads them, `public.send_push_event`: the bearer under `app_internal_bearer`, and under `app_service_role_key` while the vault has nothing of that name. The vault holds one of the two names, not both; with both, `app_internal_bearer` is the one that is sent. `INTERNAL_BEARER` and the vault's copy are rotated together (runbook page, section 4). The VAPID pair is not rotated: every device's subscription is tied to the public key.

Which function runs behind the gateway's JWT check is not a secret and not a dashboard setting: it is `supabase/config.toml`.

## GitHub Actions: secrets and variables

Repository settings → Secrets and variables → Actions. A secret cannot be read back; a variable can.

| Name | Kind | Read by | What it is |
|---|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | secret | the build of `deploy.yml` | the project URL and its anon key, as in `.env` |
| `VITE_VAPID_PUBLIC_KEY` | secret | the build of `deploy.yml` | the public Web Push key; without it the push toggles say "not supported" |
| `SUPABASE_DB_URL` | secret | the `migrations` job of `deploy.yml`, and `backup.yml` | the session-pooler connection string of the project, with the database password — the `postgres` role. `BACKUPS.md`, section *The nightly run on GitHub* |
| `BACKUP_PASSPHRASE` | secret | `backup.yml` | the passphrase a backup is encrypted with |
| `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK` | variable | the `migrations` job of `deploy.yml` | normally absent. `true` lets a deploy go out unchecked while `SUPABASE_DB_URL` is not set: [runbook/40-deploy.md](runbook/40-deploy.md), section 5 |
| `MIN_CLIENT_BUILD` | variable | the build of `deploy.yml` | normally absent. The oldest build still allowed to run, as a build id — the UTC time of the build, 14 digits (`YYYYMMDDHHmmss`). It is written into `version.json`, and an open app older than it updates as soon as nothing would be lost instead of offering the update. A value that is not 14 digits, or later than the build itself, fails the build and nothing is published: [runbook/40-deploy.md](runbook/40-deploy.md), section 8 |

Without `SUPABASE_DB_URL` a push to `main` publishes nothing: the deploy stops at `migrations`. `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` are set since 2026-10-13, the day of the first publication of the review.

## Migration from Windows-side Claude

If you were running Claude Code from Windows and want to switch:

1. Stop any running Windows-side Claude session.
2. Install Claude inside WSL (see step 1 above).
3. Set git identity inside WSL (step 2).
4. Delete any worktrees whose `.git` gitdir contains `//wsl.localhost/...` — they'll be slow forever. Recreate from inside WSL.
5. Confirm a test cycle works end-to-end: trivial edit → `npm test -- --run` → `git commit` → `git push`. No identity error, no CRLF warning, no `safe.directory` warning.
6. Remove the Windows Claude checkout once the WSL flow is confirmed.
