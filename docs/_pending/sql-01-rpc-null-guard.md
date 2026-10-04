# sql-01-rpc-null-guard — docs to fold (wave 0, items P1, L29)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add as the last bullet of the section (after the bullets the `sql-00-baseline-ledger` snippet adds there):

- **A SECURITY DEFINER RPC refuses a caller without a user id first, and compares with `IS DISTINCT FROM`.** A definer bypasses RLS, so the line that compares the caller with the owner of the data is the whole gate. Written `IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN RAISE`, it lets everyone without a session through: with `auth.uid()` NULL the comparison is NULL, not true, and an `IF` on NULL skips its branch. `adopt_swap`, `adopt_skip`, `decline_promote_request`, `approve_program` and `send_back_program` authorize with `IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'not authorized'` (migration `2026_10_03_02_rpc_auth_null_guard.sql`, review finding P1). Keep that line, as written, whenever one of them is re-created — `CREATE OR REPLACE` replaces the whole body. `supabase/tests/rpc-auth.test.js` calls each of the five as anon, the service role, a token of role `authenticated` with no `sub`, `postgres`, another coach, the athlete, another athlete and an athlete of another coach, and requires `not authorized` and an unchanged database; it also lists the SECURITY DEFINER functions of `public` that are neither triggers nor `STABLE` and fails when one appears that is not in its table of calls. The service role and `postgres` are refused too: neither has a user id. `REVOKE ALL … FROM public` is not what keeps `anon` out — Supabase grants `anon` EXECUTE by name.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Replace, in the bullet that starts "**Student program authoring is an approval-gate model", the words "(coach-only SECURITY DEFINER; self-authorizes on `students.coach_id = auth.uid()`)" with:

(coach-only SECURITY DEFINER; self-authorizes with `auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid()`, where `v_coach_id` is `students.coach_id`)

Replace, in the bullet that starts "**Adopting a swap into the program is a coach-only", the words "it asserts `coach_profile_for_session(session) = auth.uid()`" with:

it refuses a caller without a user id and asserts `coach_profile_for_session(session)` is not distinct from `auth.uid()`

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add at the end of the row's file list:

`rpc-auth.test.js` (the five coach-only SECURITY DEFINER RPCs called by every kind of caller, with and without a user id; the migration `2026_10_03_02_rpc_auth_null_guard.sql` tried on the frozen baseline — hole before, closed after, back after its rollback; its audit).

## CLAUDE.md — Feature → files map, row "Adopt deviation → program edit (Phase 3.1/3.2)"

Replace "Both SECURITY DEFINER, coach self-auth," with:

Both SECURITY DEFINER, coach self-auth (`auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid()` — migration `2026_10_03_02_rpc_auth_null_guard.sql`, tests in `supabase/tests/rpc-auth.test.js`),

## README.md — Database Tests

Replace the bullet that starts "`known-holes.test.js` holds the open findings" with:

- `known-holes.test.js` holds the findings of the 2026-09-30 review as tests that assert the secure behaviour: `it.fails` while the hole is open, a plain `it` once a migration has closed it (the comment above it names the migration). To fix one: delete `.fails`, watch it go red, write the migration and merge it into `schema.sql`, keep the control tests next to it green.
- `rpc-auth.test.js` calls the five coach-only SECURITY DEFINER RPCs as every kind of caller. A new SECURITY DEFINER function that a client can call must be added to its table of calls: the test that lists them fails otherwise.

## docs/RUNBOOK.md — Checkpoint A0

Migration 02 (`docs/runbook/migrations/02-rpc-auth-null-guard.md`) is the most urgent step of the checkpoint and has no dependency but migration 01: audit, apply 01, audit, apply 02, audit again — line "coach RPCs that run without a session (P1)" must read `none` — then the dry-run check of the page's "After" section. It does not wait for the Auth dashboard steps: it changes no table and no row, and the deployed app behaves the same for a signed-in coach.

After it, `anon` still holds EXECUTE on the five functions (audit line 7) until migration 03 at Checkpoint A1. That is expected and opens nothing.

Calling one of the five from the SQL editor or with the service-role key now answers `not authorized`: neither has a user id. To run one as a given coach, use the SQL editor's role selector (authenticated, that user).
