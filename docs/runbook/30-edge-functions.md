# 30 — Edge Functions: deploy, secrets, the check after a deploy

| | |
|---|---|
| Where | the Supabase CLI, from the root of this checkout. No file of `supabase/migrations/`, no dashboard setting |
| Kind | code published to Supabase's Edge runtime, and one shared secret · no table of the app and no row is touched |
| Wave / checkpoint | from wave 1. A function deploy is a step of Checkpoint B and of the checkpoints after it; `send-push` as it stands after wave 1 may be deployed on its own, at any time ("When", below) |
| Findings | L25 (low), B18 (low) |
| Check | after every deploy and every rotation (section 3) — it writes nothing and sends no notification |

This page is for the person who owns the Supabase project. Nothing in the repository, no workflow and no agent deploys a function or sets a secret: you do, with the commands below.

## The two functions

| Function | `verify_jwt` | Called by | How it knows its caller |
|---|---|---|---|
| `send-push` | `false` | the database: every notification trigger, through pg_net | the `INTERNAL_BEARER` secret, which the function checks itself |
| `dispatch-rest-push` | `true` | the app, when a rest timer starts | the signed-in athlete's JWT: Supabase's gateway checks it, then the function reads the user from it |

`verify_jwt` is the check Supabase's gateway makes **in front of** a function: with `true`, a request without a valid user JWT is answered 401 by the gateway and the function never runs. The database has no user JWT. So `send-push` runs with `false`, and its own check is the only one.

The column is not a wish: it is `supabase/config.toml`, which the CLI reads at every deploy. A test fails when a function has no entry in that file (`supabase/functions/deploy.test.js`), and when this table and the file disagree (`supabase/functions/runbook.test.js`).

## What was wrong

**The flag lived in someone's memory (B18).** `send-push` had to be deployed with `--no-verify-jwt`, and nothing recorded it. One `supabase functions deploy send-push` without the flag puts the gateway's check in front of it. From then on every call of the database is refused before the function runs, and nothing says so: the triggers do not read the answer, and the bell rows are still written. Every push of the app — session confirmed, feedback, message, off-plan exercise, draft submitted — stops, silently, for everyone.

**The function's own check was the weak kind (L25).** It compared the bearer with `!==`, which stops at the first character that differs: the time it takes tells how much of a guess is right. It answered every request, refusals included, with `Access-Control-Allow-Origin: *`, so any web page could call it from a browser. And it read a body of any size. Nothing suggests any of it was ever used, and the function is safe for as long as the secret is. The secret is what all the rest of this page is about, because whoever has it can send a notification, with any text and any link, to any user.

## What this version does

- `supabase/config.toml` carries the flag of each function. The deploy command has no flag to forget.
- `send-push` opens with one gate (`supabase/functions/_shared/auth.js`): `POST` only, the bearer compared in constant time, a body of 8 kB at most, a JSON object. Nothing else in the function runs for a caller the gate refuses.
- No `Access-Control-*` header, and no answer to a preflight: a browser cannot call it.
- A refusal says who refuses: `send-push: unauthorized`. The check of section 3 uses that to tell the function's refusal from the gateway's.
- Without its secret the function refuses everyone with a 500, `send-push: not configured`, and writes `INTERNAL_BEARER is not set` in its log.

For the database and for the app, nothing changes: same URL, same header, same body, same answer `{"delivered":N}`.

## When

- **Checkpoint B and later**: the checkpoint lists the functions to deploy; the commands are section 1, the check is section 3.
- **`send-push` of wave 1, on its own**: at any time. It needs no migration, and the database that is in production today calls it exactly as it calls the version it replaces. It is not urgent either. If you do it, it is also the first deploy that goes through `supabase/config.toml` and through a module outside the function's folder — worth seeing work once before Checkpoint B.
- **`dispatch-rest-push`**: nothing to deploy before Checkpoint B. Its code has not changed since the version in production (v2, 2026-05-11).

## 1. Deploy

From the root of the checkout, on the branch that carries the code, with the CLI linked ([00, section 1](00-before-you-start.md)).

```bash
supabase functions deploy send-push --use-api
```

```bash
supabase functions deploy dispatch-rest-push --use-api
```

One function per command, and only the one the checkpoint asks for. Then section 3.

- **`--use-api`** has Supabase bundle the function from the files the CLI uploads. Without it the CLI bundles on this machine, in Docker, which this machine does not have.
- **Never `--no-verify-jwt`.** `supabase/config.toml` decides, function by function. The flag overrides the file — for every function named on that command line.
- **Never from the dashboard's code editor.** It deploys what is typed into it: not this repository, not `_shared/`, and with its own setting for JWT verification.
- **Never `supabase config push`.** The file holds the function flags and nothing else; a push would overwrite the project's Auth settings with the CLI's defaults ([20](20-auth-config.md)). If `supabase link` prints that the local configuration differs from the project's: it does, on purpose.
- **`Could not find the supabase-go binary`**: the CLI is installed in two parts and this shell found only the first. The message lists the fix. On this machine `~/.local/share/supabase` holds both parts: put it first in `PATH` and run the command again.

A deploy replaces the function within seconds.

## 2. Secrets

Two places hold secrets, and one value is in both.

**The functions' secrets** — set with `supabase secrets set`, read by the functions as environment variables:

| Name | Read by | What it is |
|---|---|---|
| `INTERNAL_BEARER` | `send-push` | the shared secret: who presents it may send a push to any user |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | both | the key pair that signs every push. The public half is also built into the app (`VITE_VAPID_PUBLIC_KEY`, a GitHub secret) |
| `VAPID_SUBJECT` | both | a `mailto:` address the push services may write to |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are given to every function by Supabase. Do not set them.

```bash
supabase secrets list
```

It prints names and digests, never a value. The four names of the table must be there.

**The database's vault** — read by the triggers when they call `send-push`:

| Name | What it is |
|---|---|
| `app_functions_url` | where the functions are: `https://<project ref>.supabase.co/functions/v1` |
| `app_service_role_key` | **the same value as `INTERNAL_BEARER`**. It is not the service-role key and must not be: the name is a leftover |

```bash
supabase db query --linked "select name, case when name = 'app_functions_url' then decrypted_secret end as value, updated_at from vault.decrypted_secrets where name in ('app_functions_url', 'app_service_role_key') order by name"
```

Two rows. The first shows the URL, which must be the `VITE_SUPABASE_URL` of `.env` followed by `/functions/v1`. The second shows no value — the query never prints the bearer — and the day it was last changed. With a row missing, the triggers skip the push without an error, and only the bell rows are written.

**Do not rename `app_service_role_key`.** The triggers in production read that name and no other. Migration 15 (Checkpoint B) teaches them `app_internal_bearer`; the rename is a step of that migration's page, after it is applied.

**Do not change the VAPID pair.** Every phone's subscription is tied to the public key: with a new pair, every user has to switch notifications off and on again, and the app must be rebuilt with the new public key.

## 3. The check

After every deploy of `send-push`, and after every rotation. From the root of the checkout that holds the `.env`. It reads the project URL from that file and sends at most two requests to `send-push`, for a user id nobody has: no notification is sent and nothing is written.

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/send-push", process.env.VITE_SUPABASE_URL);
const bearer = process.env.INTERNAL_BEARER;
const body = JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", payload: { title: "deploy check" } });
const ask = async (headers) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
};
const closed = await ask({});
console.log(`no bearer: ${closed}`);
if (closed !== "401 send-push: unauthorized") process.exit(1);
if (!bearer) {
  console.log("bearer: not sent, INTERNAL_BEARER is not set in this shell");
  process.exit(0);
}
const open = await ask({ authorization: `Bearer ${bearer}` });
console.log(`bearer: ${open}`);
if (open !== `200 {"delivered":0}`) process.exit(1);
'
```

It prints two lines:

| line | after a deploy | during a rotation (section 4) |
|---|---|---|
| `no bearer` | `401 send-push: unauthorized` | `401 send-push: unauthorized` |
| `bearer` | `not sent, INTERNAL_BEARER is not set in this shell` | `200 {"delivered":0}` |

The first line is the one that matters after a deploy: the function itself refused a caller without the secret. So the gateway let the request through (`verify_jwt` is off, as it must be), and the gate is in place.

The second request is made only when your shell holds the secret, which it does during a rotation and at no other time: nobody needs to keep the value, and section 4 is how you get a fresh one. It is sent only after the first line came back as above — never to something that did not answer as `send-push`.

If it does not print that:

- **`no bearer: 401 Unauthorized`** — one word. That is the version from before this page (v4, deployed 2026-05-12): the gateway lets requests through and the old check refuses. Nothing is broken. It is what the check prints until `send-push` is deployed from this branch.
- **`no bearer: 401`, then anything else** — JSON, a mention of a JWT or of an authorization header. The gateway answered, not the function: `send-push` is deployed with JWT verification **on**, and no push of the database gets through. This is finding B18. Deploy it again with the command of section 1, from the root of the checkout, and run the check again. If the line does not change, the CLI did not take the flag from `supabase/config.toml`: stop and report.
- **`no bearer: 500 send-push: not configured`** — the function runs and has no `INTERNAL_BEARER`. `supabase secrets list` must show the name; section 4 sets it.
- **`no bearer: 404`, then anything** — there is no function of that name in the project the `.env` points at.
- **`no bearer: 503`, then anything**, or a 500 that is not the line above — the function does not start. Read its log (Dashboard → Edge Functions → `send-push` → Logs), then go back to the version before ("Undo").
- **`no bearer: 200`, then anything** — the function answers a caller that shows nothing. Stop and report.
- **`bearer: 401 send-push: unauthorized`** — the value in your shell is not the function's secret. Straight after `supabase secrets set`, wait half a minute and run the check again; if it stays, run the rotation again from its first command.
- **`bearer: 500`, then `{"error":…}`** — the secret is right and the function could not read `push_subscriptions`. The message says why.
- **`node: .env: not found`** — this folder has no `.env`. Run the check from the root of the main checkout.
- **`fetch failed`** — no network, or the URL in `.env` is wrong.

For `dispatch-rest-push` there is nothing to paste: its check is a rest timer started in the app by an athlete who has *Rest end notification* on, with the phone locked.

What the check above cannot see: whether a push reaches a phone. That needs a device whose user switched notifications on — on 2026-10-03 the coach account had none, so every push meant for the coach reached nobody (avatar → **Notifications** → *Enable*, on the coach's phone). The real test is a message from the coach to the test athlete, with the athlete's phone locked.

## 4. Rotating `INTERNAL_BEARER`

When: once now, if the value in use is the project's service-role key or anything that was ever pasted somewhere (the first set-up suggested that key as "convenient": it opens the whole database, and `send-push` needs nothing of the sort); then whenever the value may have been seen by someone else; otherwise about once a year.

The value is a random string that nobody has to know. It is made in the shell, sent to the two places that hold it, and forgotten.

Between the second and the third command the two places disagree, and a push the database sends in that moment is refused (its bell row is written all the same). Run them one right after the other, at an hour when nobody trains.

```bash
export INTERNAL_BEARER="$(openssl rand -hex 32)"
```

```bash
supabase secrets set INTERNAL_BEARER="$INTERNAL_BEARER"
```

```bash
supabase db query --linked "select vault.update_secret(id, '$INTERNAL_BEARER') from vault.secrets where name = 'app_service_role_key'"
```

Then that both places hold the value of this shell. The function's side is the check of section 3: its second line now reads `bearer: 200 {"delivered":0}`. The database's side:

```bash
supabase db query --linked "select decrypted_secret = '$INTERNAL_BEARER' as vault_holds_the_value_of_this_shell from vault.decrypted_secrets where name = 'app_service_role_key'"
```

One row, `true`. `false`: the third command did not run in this shell, run it again. No row: the vault has no secret of that name, and the database was sending no push at all. Create it, then run the line above again, and check that `app_functions_url` exists too (section 2):

```bash
supabase db query --linked "select vault.create_secret('$INTERNAL_BEARER', 'app_service_role_key')"
```

Then let go of it:

```bash
unset INTERNAL_BEARER
```

Two things the earlier instructions got wrong, in case you remember them: the vault is changed with `vault.update_secret`, not with `UPDATE vault.secrets` (the value is stored encrypted, and the table cannot be written directly); and the secret is not the service-role key.

## Undo

A function has no rollback file: going back is deploying the old code. The code in production before this page (v4) is `supabase/functions/send-push/index.ts` as commit `a61f0c31f2` has it. That commit is already on GitHub's `main`, so the command finds it whatever happens to the branch this page came with.

```bash
git restore --source=a61f0c31f2 --worktree -- supabase/functions/send-push/index.ts
```

```bash
supabase functions deploy send-push --use-api
```

```bash
git restore -- supabase/functions/send-push/index.ts
```

The first command changes one file of the working tree, the last puts it back. In between, the check of section 3 prints `no bearer: 401 Unauthorized`. The flag still comes from `supabase/config.toml`, which is right for the old code too. The secret is not part of a deploy: undoing a rotation is rotating again.

When to: the function does not start after a deploy, or the check prints something this page does not explain. Not for a failed rotation — the code is not the problem there.
