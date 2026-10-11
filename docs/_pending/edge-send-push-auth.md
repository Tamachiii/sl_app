# edge-send-push-auth — docs to fold (wave 1, items L25, B18)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**Two Edge Functions handle delivery, split by call shape.**", the sentence "[send-push](../supabase/functions/send-push/index.ts) is **internal-only** — it requires `Authorization: Bearer <service-role-key>` and is called by the DB trigger `notify_student_on_session_feedback` via pg_net." with:

[send-push](../supabase/functions/send-push/index.ts) is **internal-only** — it requires `Authorization: Bearer <INTERNAL_BEARER>`, a secret of its own that is not the service-role key, and is called by the notification triggers via pg_net.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace the whole bullet that starts "**Supabase Vault feeds the trigger; the function checks `INTERNAL_BEARER`.**" with:

- **Supabase Vault feeds the triggers; the function checks `INTERNAL_BEARER`.** Every notification trigger reads `app_functions_url` and `app_service_role_key` from `vault.decrypted_secrets` and sends the second as `Authorization: Bearer <value>` to send-push, which compares it with its `INTERNAL_BEARER` secret (set with `supabase secrets set`). **The two must hold the same value**, and that value is not the service-role key, whatever the vault name says: it is a random string made for this purpose, because whoever has it can push any text and any link to any user. We don't reuse Supabase's auto-injected `SUPABASE_SERVICE_ROLE_KEY` for the check either: newer projects get an `sb_secret_*` key whose full value can't be read back outside the dashboard, so the two ends would drift. Without the vault secrets the trigger's push block silently no-ops and the in-app `notifications` row still gets written — so the feature degrades cleanly on dev environments. `ALTER DATABASE postgres SET app.*` is denied on Supabase's managed Postgres — don't reach for GUCs. The vault's copy is changed with `vault.update_secret(id, '<new>')`, never with `UPDATE vault.secrets`: the owner's role may not write that table, and the value is stored encrypted. Rotation is the owner's, by hand: `docs/runbook/30-edge-functions.md`, section 4, whose statements `supabase/tests/push-secrets.test.js` reads off the page and runs.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**Supabase Vault feeds the triggers; the function checks `INTERNAL_BEARER`.**":

- **`supabase/config.toml` says, for every Edge Function, whether the gateway asks for a user JWT.** `verify_jwt = false` for send-push (its caller is the database, which has no user JWT), `true` for dispatch-rest-push. The deploy is a plain `supabase functions deploy <name> --use-api`; `--no-verify-jwt` is never passed by hand, because the flag overrides the file. Without the file a deploy that forgets the flag puts the gateway's 401 in front of send-push, and every push of the app stops with no error anywhere: the triggers never read the answer. `supabase/functions/deploy.test.js` fails when a function directory has no `[functions.<name>]` table, when `verify_jwt` is not written out, or when the flags are not the ones in production. The file carries nothing else (`src/test/authConfig.test.js`), and `supabase config push` stays forbidden.
- **A function the gateway does not guard opens with `admitInternalRequest`, and nothing runs for a caller it refuses.** `supabase/functions/_shared/auth.js` is the whole gate: `POST` only (a preflight gets a 405 and no `Access-Control-*` header, so a browser cannot call the function), the bearer compared with `timingSafeEqual` (never `===`, whose duration tells how long the matching prefix is), a body of `MAX_BODY_BYTES` at most, counted while it is read, and a JSON object. An unset secret refuses everyone with a 500 — `"Bearer undefined"` must never open anything. A refusal is plain text that starts with the function's name (`send-push: unauthorized`): the check of the runbook tells the function's refusal from the gateway's by that text, so do not reword it without the page. Do not add CORS headers to an internal function, and do not read the body before the bearer is judged.
- **What an Edge Function decides lives in `supabase/functions/_shared/*.js`; `index.ts` is an adapter.** A shared module uses web standards only (`Request`, `Response`, streams) — no `Deno.*`, no `jsr:` or `npm:` import — and takes its dependencies as arguments, so vitest runs it under Node (`// @vitest-environment node`). Deno is not installed where the tests run. The adapter reads the environment and wires things together, and is tested too: `supabase/functions/_test/harness.js` (`loadFunction`) imports an `index.ts` with a stand-in `Deno` global and its remote imports replaced, and returns the handler it passed to `Deno.serve`. A shared module is imported by a relative path with its extension (`'../_shared/auth.js'`): `supabase functions deploy --use-api` uploads the files it finds by matching the `import` lines with a regular expression, comments included, and `supabase/functions/deploy.test.js` runs that expression over every function to see that it finds each file and nothing else.
- **Nothing in the repository deploys a function or sets a secret.** The owner does, following `docs/runbook/30-edge-functions.md`. The check that page gives for after a deploy is read off the page and run by `supabase/functions/runbook.test.js` against `send-push/index.ts` itself, behind a real port, and against what a wrong deploy answers; it sends the secret only to something that has first answered as send-push.

## docs/ENVIRONMENT.md — Supabase Auth settings (production)

Replace "a `supabase/config.toml`, when the Edge Functions bring one, carries their flags only" with:

`supabase/config.toml` carries the Edge Functions' flags only

## docs/ENVIRONMENT.md — new section "Edge Function secrets (production)", after "Supabase Auth settings (production)"

Add:

````markdown
## Edge Function secrets (production)

Set by hand by the project's owner, following [runbook/30-edge-functions.md](runbook/30-edge-functions.md). No file of the repository holds a value, and `.env` holds none of them.

The functions' secrets (`supabase secrets set`, read as environment variables):

| Name | Read by | What it is |
|---|---|---|
| `INTERNAL_BEARER` | `send-push` | the secret the database presents; a random string (`openssl rand -hex 32`), not the service-role key |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `send-push`, `dispatch-rest-push` | the pair that signs every push; the public half is also `VITE_VAPID_PUBLIC_KEY` at build time |
| `VAPID_SUBJECT` | `send-push`, `dispatch-rest-push` | a `mailto:` address |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase.

The database's vault (read by the notification triggers):

| Name | What it is |
|---|---|
| `app_functions_url` | `https://<project ref>.supabase.co/functions/v1` |
| `app_service_role_key` | the same value as `INTERNAL_BEARER` (the name is historical) |

`INTERNAL_BEARER` and `app_service_role_key` are rotated together (runbook page, section 4). The VAPID pair is not rotated: every device's subscription is tied to the public key.

Which function runs behind the gateway's JWT check is not a secret and not a dashboard setting: it is `supabase/config.toml`.
````

## README.md — Rest Timer (in-app + Web Push)

Replace the paragraph that starts "A second Edge Function, [`send-push`](supabase/functions/send-push/index.ts), is a service-role-auth fan-out used by DB triggers" with:

A second Edge Function, [`send-push`](supabase/functions/send-push/index.ts), is the fan-out the database's notification triggers call through pg_net (feedback, session confirmed, off-plan exercise, chat message, draft submitted, approved or sent back). It is internal: the triggers present a shared secret, `INTERNAL_BEARER`, which they read from Supabase Vault (`app_service_role_key`, next to `app_functions_url`), and the function's gate — [`_shared/auth.js`](supabase/functions/_shared/auth.js): POST only, the bearer in constant time, a body of 8 kB at most, no CORS — lets nobody else in.

## README.md — Rest Timer (in-app + Web Push)

Replace everything from "To deploy the functions:" to the end of the code block that follows it (it ends with "# AND  `supabase secrets set INTERNAL_BEARER=<new>`") with:

Deploying the functions, their secrets, rotating `INTERNAL_BEARER` and the check to run after a deploy are in [docs/runbook/30-edge-functions.md](docs/runbook/30-edge-functions.md). In short:

```bash
supabase functions deploy send-push --use-api
```

No `--no-verify-jwt`: [supabase/config.toml](supabase/config.toml) says which function runs without the gateway's JWT check, and the flag would override it. The VAPID pair comes from `npx web-push generate-vapid-keys --json` (public key in `.env` as `VITE_VAPID_PUBLIC_KEY`, both halves and a `mailto:` subject as function secrets); the vault's copy of the bearer is written with `vault.create_secret` and changed with `vault.update_secret`, never with `UPDATE vault.secrets`.

## README.md — Testing Conventions

Add after the bullet that starts "Mocks: child hooks are stubbed":

- The Edge Functions are tested here too, although they are Deno: what a function decides is in `supabase/functions/_shared/*.js` (web standards only, run under Node), and `supabase/functions/_test/harness.js` loads an `index.ts` with a stand-in `Deno` and its remote imports replaced. `supabase/functions/deploy.test.js` holds `supabase/config.toml` to the function folders, and `supabase/functions/runbook.test.js` runs the runbook's check after a deploy against `send-push` behind a real port.

## README.md — Database Tests

Add after the bullet that starts "`auth-accounts.test.js` runs the account list":

- `push-secrets.test.js` runs the vault statements of `docs/runbook/30-edge-functions.md` — looking at the two secrets, rotating the bearer, creating it — read off the page, and checks that the triggers then send the new value.

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "`rpc-auth.test.js` and `auth-accounts.test.js`: the commands and queries the runbook pages give, read off the page and run." with:

`rpc-auth.test.js`, `auth-accounts.test.js` and `push-secrets.test.js`: the commands and queries the runbook pages give, read off the page and run.

## docs/ARCHITECTURE.md — Testing

Add after the paragraph that starts "There are three suites, each with its own command and config.":

The Edge Functions (`supabase/functions/`) are Deno programs, and Deno is not installed where the suites run; CI type-checks them (`deno check`, job `functions`) and nothing else there executes them. So their tests are part of `npm test`: a `*.test.js` next to the source, with `// @vitest-environment node`. `_shared/*.js` holds what a function decides, written against web standards only, and is tested directly. `_test/harness.js` is for the adapters: `loadFunction(name, { env, modules })` imports `<name>/index.ts` with a stand-in `Deno` global (`env.get`, `serve`) and each `jsr:` / `npm:` specifier replaced, and returns the handler; `fakeAdmin(tables)` is the part of a supabase-js client the functions use; `listen(handler)` serves a handler on a port of `127.0.0.1`, which is how `runbook.test.js` runs the runbook's check — a pasted `node` command — against the function.

## CLAUDE.md — Repo map

Replace the line "functions/dispatch-rest-push/  functions/send-push/" with:

```
                 config.toml (which Edge Function runs behind the gateway's JWT
                 check — function flags only, never pushed)
                 functions/dispatch-rest-push/  functions/send-push/ (index.ts =
                 adapter)  functions/_shared/ (what a function decides: auth.js,
                 runtime-neutral, under vitest)  functions/_test/harness.js
                 (loads an index.ts under Node)  functions/deploy.test.js
                 functions/runbook.test.js
```

## CLAUDE.md — Feature → files map, row "Event push fan-out (send-push Edge Function via pg_net)"

Replace "`supabase/functions/send-push/`. Triggers that call it" with:

`supabase/functions/send-push/` (`index.ts` adapter + `index.test.js`), `supabase/functions/_shared/auth.js` (`admitInternalRequest` — the gate: POST only, `INTERNAL_BEARER` via `timingSafeEqual`, 8 kB body, no CORS). Triggers that call it

## CLAUDE.md — Feature → files map, new row after "Event push fan-out (send-push Edge Function via pg_net)"

Add:

| Edge Function deploy, secrets, bearer rotation (by hand, by the owner) | `supabase/config.toml` (`verify_jwt` per function — nothing else), `docs/runbook/30-edge-functions.md` (deploy commands, secrets, the check after a deploy, rotating `INTERNAL_BEARER`, undo), `supabase/functions/deploy.test.js` (config ↔ function folders; the files a deploy uploads), `supabase/functions/runbook.test.js` (page ↔ config; the page's check run against `send-push/index.ts` behind a port), `supabase/functions/_test/harness.js` (`loadFunction`/`fakeAdmin`/`listen`), `supabase/tests/push-secrets.test.js` (the page's vault statements against the triggers), `docs/ENVIRONMENT.md` (the secrets' names) |

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add after "`smoke.test.js`,":

`push-secrets.test.js` (the vault statements of `docs/runbook/30-edge-functions.md`, read off the page),

## CLAUDE.md — When you add a feature

Replace the bullet that starts "A new Edge Function is a directory under `supabase/functions/` with an `index.ts`" with:

   - A new Edge Function is a directory under `supabase/functions/` with an `index.ts`; shared modules live in a directory whose name starts with `_`. `src/test/ciGuardrails.test.js` fails otherwise, because the CI glob would skip the function. It also needs its `[functions.<name>]` table in `supabase/config.toml` with `verify_jwt` written out, a row in the table of `docs/runbook/30-edge-functions.md` and a deploy command there (`supabase/functions/deploy.test.js` and `runbook.test.js` fail otherwise). Its logic goes into `supabase/functions/_shared/<module>.js` — web standards only, dependencies as arguments, tested with vitest under `// @vitest-environment node` — and `index.ts` stays an adapter, tested through `loadFunction` of `supabase/functions/_test/harness.js`. With `verify_jwt = false` the function opens with `admitInternalRequest`. Run `npx vitest run supabase/functions --maxWorkers=2`.

## docs/RUNBOOK.md — the table of pages, after the row of `runbook/20-auth-config.md`

Add:

| [runbook/30-edge-functions.md](runbook/30-edge-functions.md) | the Edge Functions: the deploy command, their secrets, the check after a deploy, rotating the shared bearer, going back to the version before |

## docs/RUNBOOK.md — the wave-1 checkpoint that is handed over last (A3), as an "### Optional — …" step

Add:

````markdown
### Optional — `send-push` with its new gate

Page: [runbook/30-edge-functions.md](runbook/30-edge-functions.md). Not a migration, and nothing waits for it: the function is deployed in any case at Checkpoint B. Doing it now closes finding L25 (the function compared its secret in a way that leaks it slowly, and answered any browser) and tries the deploy once on a small change. The database in production calls the new version exactly as it calls the old one.

```bash
supabase functions deploy send-push --use-api
```

No `--no-verify-jwt`: `supabase/config.toml` carries the flag now (finding B18). Then the check of section 3 of the page, from the root of the checkout. Its first line must read `no bearer: 401 send-push: unauthorized`. Before the deploy the same check prints `no bearer: 401 Unauthorized`; anything else is explained on the page.

Then, once: rotate the shared secret (section 4 of the page) if the value in use is the project's service-role key or was ever pasted anywhere. Five commands, at an hour when nobody trains.
````
