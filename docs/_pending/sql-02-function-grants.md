# sql-02-function-grants — docs to fold (wave 1, items B2, L21, L23)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**A SECURITY DEFINER RPC refuses a caller without a user id first**":

- **No function of `public` is executable without a session, and a signed-in user executes an allow-list.** Supabase grants `anon`, `authenticated` and `service_role` EXECUTE, by name, on every function `postgres` creates in `public`, on top of the EXECUTE PostgreSQL gives `PUBLIC`; `REVOKE … FROM public` next to a function removes one of those four grants. Migration `2026_10_11_03_function_grants_lockdown.sql` takes everything back from `PUBLIC`, `anon` and `authenticated` and grants `authenticated` an explicit list: the helpers the policies call and the RPCs the app calls. A policy is evaluated with the privileges of the user who queries the table, so **a helper that is missing from the list fails every query on every table whose policies name it** (`permission denied for function …`) — so does a function in a column default, a check constraint, a view or an index expression. A trigger function gets no grant: a trigger fires whatever the privileges of the user whose statement fires it (GoTrue fires `handle_new_user` as `supabase_auth_admin`, which may not execute it). `service_role` and the owner keep everything. In `schema.sql` the list is the `FUNCTION PRIVILEGES` block at the end of the file, the only place that grants or revokes on a function; it stays below every function of the file. `supabase/tests/function-acl.test.js` holds all of it against the catalog — anon and `PUBLIC` execute nothing, `authenticated` exactly the lists `HELPERS` and `RPCS` of that file, every function a policy depends on (read from `pg_depend`) is a helper of the list, every name `src/` passes to `supabase.rpc()` is an RPC of the list — and a function that joins `public` fails it until it is listed or is a trigger function.
- **A function `postgres` creates starts closed.** Since the same migration, the default privileges of `postgres` give a new function no EXECUTE for `PUBLIC` in any schema (a global default: the `PUBLIC` grant is PostgreSQL's built-in one, and a per-schema default can only add to it) and none for `anon` or `authenticated` in `public`. A function created by a migration, or by hand in the SQL editor, is executable by `postgres` and `service_role` until a `GRANT` names someone else. A migration that adds a function says so next to it (`REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated`, then `GRANT EXECUTE … TO authenticated` when a policy or the app calls it) — rules in `supabase/migrations/README.md`, "A migration that creates or re-creates a function". The defaults of `supabase_admin`, the platform's own role, are untouched: `postgres` cannot change them, and nothing of the app is created by that role.
- **Every function runs with `search_path = public, pg_temp`.** All functions of `public` carry `SET search_path = public, pg_temp` and write the names in their bodies with a schema (`public.sessions`, `auth.uid()`, `net.http_post`, `vault.decrypted_secrets`). Without the clause a `SECURITY DEFINER` function resolves names with the caller's path; with `public` alone, a temporary object of the caller still comes first. `CREATE OR REPLACE` **drops a `SET` clause the new text does not repeat** (and keeps the grants): repeat it whenever a function is re-created, in the migration and in `schema.sql`. `function-acl.test.js` fails on any function of `public` whose setting is not exactly that one.

Replace, in the bullet that starts "**A SECURITY DEFINER RPC refuses a caller without a user id first**", the text from "`supabase/tests/rpc-auth.test.js` calls each of the five as anon" to the end of the bullet with:

`supabase/tests/rpc-auth.test.js` calls each of the five as the service role, a token of role `authenticated` with no `sub`, `postgres`, another coach, the athlete, another athlete and an athlete of another coach, and requires `not authorized` and an unchanged database; it also lists the SECURITY DEFINER functions of `public` that are neither triggers nor `STABLE` and fails when one appears that is not in its table of calls. The service role and `postgres` are refused too: neither has a user id. `anon` no longer reaches the body — since migration 03 it may execute no function, and the same test requires `permission denied for function …` for it — but the line in the body stays the gate for every caller that does hold EXECUTE.

Replace, in the bullet that starts "**RLS is strict.**", the sentence "New tables need both student- and coach-side policies walking session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers in `schema.sql`." with:

New tables need both student- and coach-side policies walking session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers in `schema.sql`. A helper a policy calls must be executable by `authenticated`: a new one joins the `FUNCTION PRIVILEGES` block at the end of `schema.sql` and the `HELPERS` list of `supabase/tests/function-acl.test.js`.

Replace, in the bullet that starts "**Nothing in the repository applies SQL to production, and nothing may.**", "(`supabase/tests/rpc-auth.test.js`, `supabase/tests/auth-accounts.test.js`, `src/test/authConfig.test.js`)" with:

(`supabase/tests/rpc-auth.test.js`, `supabase/tests/function-acl.test.js`, `supabase/tests/auth-accounts.test.js`, `src/test/authConfig.test.js`)

Replace, in the bullet that starts "**`supabase/tests/snapshots/rls-matrix.txt` is the record of who can do what.**", the last sentence ("A migration that rewrites policies or grants … commits the diff.") with:

A migration that rewrites policies or grants and means to change nothing must leave it untouched; one that means to change a cell regenerates the file and commits the diff. A cell reads `denied` when the whole statement is refused for want of a privilege — on the table, or on a function one of its policies calls: that is what `anon` gets from every table whose policies name a helper.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "Tables like `set_logs`, `session_confirmations`, `slot_comments`":

**Who may execute a function.** The helpers are `SECURITY DEFINER`: they bypass RLS, which is what lets a policy on one table look at another without recursing into that table's policies — and what made them a lookup for anyone while every function of `public` was executable with the anon key alone. The grant model since migration `2026_10_11_03_function_grants_lockdown.sql`:

| Role | May execute |
|---|---|
| `anon`, `PUBLIC` | nothing in `public` |
| `authenticated` | the allow-list: the helpers the policies call (`student_profile_for_slot`, `student_profile_for_session`, `student_profile_for_set_log`, `student_profile_for_goal`, `coach_profile_for_session`, `coach_profile_for_goal`, `profiles_are_coach_student`, `program_active_for_session`, `program_active_for_slot`, `program_is_own_draft`, `week_is_own_draft`, `session_is_own_draft`) and the RPCs the app calls (`adopt_swap`, `adopt_skip`, `decline_promote_request`, `approve_program`, `send_back_program`, `save_draft_tree`, `move_session`) |
| `service_role`, `postgres` | everything |

Trigger functions are on no list: firing a trigger needs no privilege on its function. The list lives in the `FUNCTION PRIVILEGES` block at the end of `schema.sql`; a function `postgres` creates later is executable by `postgres` and `service_role` only, until a `GRANT` is written. Every function carries `SET search_path = public, pg_temp`. A request without a session is therefore refused — `permission denied for function …` — by every RPC and by every table whose policies call a helper, where it used to get an empty answer.

Replace, under "**When you add a table**", item 1 ("Both student-side and coach-side policies using these helpers (or equivalents).") with:

1. Both student-side and coach-side policies using these helpers (or equivalents). A new helper is `SECURITY DEFINER`, carries `SET search_path = public, pg_temp`, and is granted to `authenticated` in the `FUNCTION PRIVILEGES` block of `schema.sql` and in its migration — `supabase/tests/function-acl.test.js` fails until it is listed there.

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 11 files and `258 passed | 7 expected fail`.

Add after the bullet that starts "- `rpc-auth.test.js` calls the five coach-only SECURITY DEFINER RPCs":

- `function-acl.test.js` holds who may execute what: no function of `public` for `anon` or `PUBLIC`, an explicit list for a signed-in user, everything for the service role, and `search_path = public, pg_temp` on every function. A migration that adds a function adds it to `HELPERS`, `RPCS` or `NOT_FOR_USERS` in that file (a trigger function joins none), and to the `FUNCTION PRIVILEGES` block at the end of `schema.sql` when it is granted — the rules are in `supabase/migrations/README.md`.
- `asPlatformRole(role, fn)` runs `fn(q, owner)` as a role `postgres` cannot become — `supabase_auth_admin`, the role GoTrue creates accounts as. It has a connection and a transaction of its own, rolled back at the end: it sees committed fixtures (`seed()`), not what an enclosing `scenario()` wrote.

Replace, under "**Limits of the shim.**", "There is no GoTrue (`auth.users` is a subset, rows are inserted directly)" with:

There is no GoTrue (`auth.users` is a subset; rows are inserted directly, as `postgres` or — with `asPlatformRole('supabase_auth_admin', …)` — as the role GoTrue uses)

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `rpc-auth.test.js`:

`function-acl.test.js` (who may execute the functions of `public`: nothing for `anon`/`PUBLIC`, the lists `HELPERS` + `RPCS` for `authenticated`, everything for `service_role`; `search_path = public, pg_temp` on every function; a function created later starts closed; every helper called by an athlete and the coach, every trigger function fired once; migration `2026_10_11_03_function_grants_lockdown.sql` tried on the frozen baseline with the checks of its runbook page read off the page); `asPlatformRole()` in `harness.js` (run as GoTrue's role, `supabase_auth_admin`, which `postgres` cannot become)

## CLAUDE.md — When you add a feature

Add to step 2, after "the same change merged into `supabase/schema.sql` with the migration's name added to the ledger `INSERT` at the end of that file.":

A function that is created or re-created follows "A migration that creates or re-creates a function" in `supabase/migrations/README.md`: `SET search_path = public, pg_temp` in its definition, its `REVOKE`/`GRANT` next to it in the migration, its grant in the `FUNCTION PRIVILEGES` block at the end of `schema.sql` (the only place that grants on a function there), and its name in a list of `supabase/tests/function-acl.test.js`.

Replace, in step 3, "(`src/test/authConfig.test.js`, `supabase/tests/auth-accounts.test.js`, `supabase/tests/rpc-auth.test.js`)" with:

(`src/test/authConfig.test.js`, `supabase/tests/auth-accounts.test.js`, `supabase/tests/rpc-auth.test.js`, `supabase/tests/function-acl.test.js`)

## docs/RUNBOOK.md — new section "Checkpoint A1 — …", after the section of Checkpoint A0

Add when Checkpoint A1 is handed over (its row marked **ready**). The sequence, every command taken from `docs/runbook/migrations/03-function-grants-lockdown.md` as it stands there, one per fence:

1. a dump less than a day old ([00, section 2](runbook/00-before-you-start.md));
2. the audit of migration 03 — it reads as the "before" column of the page's table;
3. the migration, alone: A1 holds this file and nothing else;
4. the audit again — the "after" column, and **line 7 reads `none`**;
5. the ledger: three rows;
6. the page's check as `anon`, which must fail with `permission denied for function student_profile_for_slot`;
7. the page's check as a signed-in role, which must not fail;
8. the smoke check in the app that is deployed, as an athlete and as the coach (step 5 of the page's "After").

Name the rollback file, `supabase/rollbacks/2026_10_11_03_function_grants_lockdown.down.sql`, and when it is run: any `permission denied for function …` in steps 4, 7 or 8. Link the page as `](runbook/migrations/03-function-grants-lockdown.md)`. Checkpoint A2 does not start before step 8 is done.

Say once, in the rules that hold at every checkpoint or in this section: from this migration on, a function created by hand in the SQL editor is executable by `postgres` and the service role only, until a `GRANT EXECUTE … TO authenticated` is written for it.
