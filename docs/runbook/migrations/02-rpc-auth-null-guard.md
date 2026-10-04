# 02 — Coach RPCs refuse callers without a session

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_03_02_rpc_auth_null_guard.sql` |
| Audit | `supabase/audits/2026_10_03_02_rpc_auth_null_guard.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_03_02_rpc_auth_null_guard.down.sql` |
| Kind | required · replaces six function bodies, changes no table and no row |
| Wave / checkpoint | 0 / A0 |
| Findings | P1 (critical), L29 |
| Needs | migration 01 |

**Apply it as soon as you can.** It is the most urgent fix of the review, it does not depend on any client change, and it is safe with the app that is deployed today.

## What it does

Five database functions are reserved to the coach of the athlete they act on: `adopt_swap`, `adopt_skip`, `decline_promote_request`, `approve_program`, `send_back_program`. They run with the owner's rights (they bypass RLS), so each one checks the caller itself. That check compared the athlete's coach with the caller's user id — and when there is **no** caller id, the comparison is neither true nor false, and the function went on.

Today, anyone who has the public anon key (it is in the app's JavaScript) and the id of a slot or of a draft can, without signing in:

- delete an athlete's upcoming exercises (`adopt_skip`),
- change which exercise they are (`adopt_swap`),
- approve an athlete's draft program (`approve_program`),
- send a submitted draft back (`send_back_program`),
- clear a "make this permanent" request (`decline_promote_request`).

The migration replaces the check, in all five, with one that refuses first when there is no user id:

```sql
IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
  RAISE EXCEPTION 'not authorized';
```

Nothing else in them changes: same arguments, same results, same grants, same error message.

It also re-creates the trigger function `notify_coach_on_program_submit`, for one string. Two warnings written to the database log read `send-push (…) failed` in the repository and `send-push fan-out (…) failed` in production; the migration settles on production's wording (L29). After it, the six functions have in production exactly the text of `supabase/schema.sql`.

What it does **not** do: `anon` keeps the right to *execute* the five. Migration 03 (Checkpoint A1) takes that away for every function at once. From this migration on, that right opens nothing — the function refuses in its first lines.

## What the deployed client does differently

Nothing, for a signed-in coach: the app calls the five functions as before and gets the same answers.

Two callers get `not authorized` where the call used to go through:

- **A coach whose session has expired** while the app was open. Without a session the app sends the anon key: adopting a swap, approving a draft and so on now show an error, and signing in again fixes it. (Before, the action went through as an anonymous call.)
- **You, in the SQL editor, in the CLI or with the service-role key.** None of them has a user id. To run one of the five as a given coach, use the SQL editor's role selector → *authenticated* → that user.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_03_02_rpc_auth_null_guard.audit.sql
```

A clean result, before applying ("the five" is the list of line 2):

| check | value | expected |
|---|---|---|
| running as | `postgres` | postgres |
| coach RPCs found | `adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean); approve_program(uuid); decline_promote_request(uuid); send_back_program(uuid)` | the same list |
| coach RPCs that run without a session (P1) | the five | the five of line 2 before, none after |
| coach RPCs a signed-in user cannot execute | `none` | none |
| coach RPCs that are not SECURITY DEFINER with a search_path | `none` | none |
| coach RPCs not owned by postgres | `none` | none |
| coach RPCs anon may execute | the five | the five of line 2, until migration 03 |
| push warnings worded "send-push fan-out (…) failed" (L29) | `notify_coach_on_program_submit; send_back_program` | the same list |

If it is not clean:

- **running as** is not `postgres` — stop and report.
- **coach RPCs found** has a sixth entry (one of the names twice, with other arguments) — stop and report. The migration refuses to run in that case (`would not replace: …`), because it would fix one copy and leave the other open.
- **coach RPCs found** lacks one of the five — go on: the migration creates it. Tell whoever maintains the app, because the app calls all five.
- **line 3 reads `none` before you applied anything** — the fix is already in the database. Read the ledger (below): if migration 02 is there, you are done.
- **line 4 or 5 is not `none`** — go on, and report it. The migration puts back `SECURITY DEFINER`, the search path and the right of signed-in users to call the five.
- **line 6 is not `none`** — stop and report. A function that `postgres` does not own cannot be replaced by this file: it would fail with `must be owner of function` and change nothing.
- **line 8 reads `none` or one name only** — go on. It only means production had the repository's wording for those log lines; the migration sets both.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_03_02_rpc_auth_null_guard.sql
```

`needs 2026_10_03_01_migration_ledger, which is not applied` (code `SLM02`) means migration 01 has not been run: apply it first.

## After

1. Run the audit again. Line 3 now reads `none`; every other line is unchanged (line 8 lists both names).

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: two rows, `2026_10_03_01_migration_ledger` and `2026_10_03_02_rpc_auth_null_guard`.

3. See the refusal for yourself. This asks `adopt_skip` for a **dry run** — it counts what it would remove and writes nothing, whether the migration is applied or not — as a caller without a user id, which is what you are in the CLI:

   ```bash
   supabase db query --linked "select public.adopt_skip((select id from public.exercise_slots order by id limit 1), true)"
   ```

   The command must fail with `not authorized`. That failure is the fix: run before the migration, the same command answers `{"applied": <n>, "dry_run": true}`.

4. In the app, signed in as the coach, if a session to review has a swap or a skip: open its *Adopt into program* (or *Remove from upcoming*) dialog. It must show its count as before. You do not need to confirm it.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_03_02_rpc_auth_null_guard.down.sql
```

**It reopens the hole.** Run it only if, after the migration, a signed-in coach is refused (`not authorized`) on an athlete of their own by one of the five functions — the database tests call all five as the coach, so this is not expected. Report it, and re-apply the migration as soon as the cause is known.

What it restores is the text of the repository from before the migration. The behaviour is the one production had; the two log warnings then read `send-push (…) failed` rather than production's former `send-push fan-out (…) failed`. No table and no row is touched, in either direction.

It is refused (code `SLM04`) once a later migration is in the ledger: later migrations re-create some of these functions, and the rollback would overwrite them. Roll those back first, last applied first.
