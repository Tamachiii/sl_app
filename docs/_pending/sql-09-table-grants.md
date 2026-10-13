# sql-09-table-grants — docs to fold (wave 1, items L24)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Every function runs with `search_path = public, pg_temp`.**" (the one `docs/_pending/sql-02-function-grants.md` adds):

- **No table of `public` is reachable without a session, and a signed-in user holds the four privileges about rows — nothing else.** Supabase grants `anon`, `authenticated` and `service_role` every privilege, by name, on every table `postgres` creates in `public`: row-level security was the only gate, and it is a gate for rows. `TRUNCATE` is not subject to it and fires none of the `DELETE` triggers that guard logged training — `TRUNCATE public.profiles CASCADE`, run as `anon` or as any signed-in user, emptied every table of the app. Migration `2026_10_13_14_table_grants_lockdown.sql` (review L24) takes everything on every table, view and sequence of `public` away from `anon` and `PUBLIC`, and leaves `authenticated` `SELECT`, `INSERT`, `UPDATE` and `DELETE` on a table — the four the policies judge — and `USAGE` on a sequence; `TRUNCATE`, `REFERENCES`, `TRIGGER` and `MAINTAIN` are the owner's and the service role's. In `schema.sql` this is the `TABLE PRIVILEGES` block at the end of the file, the only place that grants or revokes on a table of `public`; it stays below every table, view and sequence of the file. `supabase/tests/table-acl.test.js` holds it against the catalog, for every table there is. A `SECURITY INVOKER` function runs with these rights: one that needs more than rows — a `TRUNCATE`, a `REINDEX` — fails for every signed-in user, and is written `SECURITY DEFINER` with its own check of who calls instead. A row lock (`SELECT … FOR UPDATE`, which the functions of migrations 11 and 12 take) asks for `UPDATE`, which stays.
- **Every table of `public` has row-level security, and a table `postgres` creates starts with the privileges of the others.** The default privileges of `postgres` in `public` give a new table nothing for `anon` and the four privileges for `authenticated` — so a table created without `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, by a migration or by hand in the SQL editor, is read and written in full by every signed-in account. `table-acl.test.js` fails on a table without row-level security, and on a view that is not `WITH (security_invoker = true)`: a view reads its tables with the rights of its owner, whom row-level security does not hold, and shows every row to whoever may read it. A migration that adds a table follows "A migration that creates a table, a view or a sequence" in `supabase/migrations/README.md`. The defaults of `supabase_admin`, the platform's own role, are untouched — `postgres` cannot change them.
- **Nothing is read or written without a session.** A request that carries only the anon key is refused by every table of `public` — `permission denied for table …`, `42501` — before a policy is evaluated, and by every function (migration 03). The app sends none: the login page talks to `/auth/v1` only, and the one way there is a session that expired and could not be renewed, where `mutationErrorKey` shows the refusal as `errors.notAllowed` and a read fails instead of resolving to no rows. A feature that must serve something without a session cannot do it with a policy alone: it needs a deliberate `GRANT … TO anon` on one table or one function, which `table-acl.test.js` and `function-acl.test.js` refuse until the rule is changed there, with the reason.

Add to the end of the bullet that starts "**RLS is strict.**" (as `docs/_pending/sql-02-function-grants.md` leaves it):

A new table enables row-level security in the migration that creates it and is defined above the `TABLE PRIVILEGES` block of `schema.sql`; `supabase/tests/table-acl.test.js` fails on one that has none.

Replace, in the bullet that starts "**`supabase/tests/snapshots/rls-matrix.txt` is the record of who can do what.**" (as `docs/_pending/sql-02-function-grants.md` leaves it), "that is what `anon` gets from every table whose policies name a helper." with:

since migration `2026_10_13_14_table_grants_lockdown.sql` that is every `anon` cell of a table of `public`: without a session there is no privilege on any of them.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "Trigger functions are on no list" (the one `docs/_pending/sql-02-function-grants.md` adds):

**Who holds what on a table.** Row-level security decides which rows; the privileges decide whether the statement is looked at at all. Since migration `2026_10_13_14_table_grants_lockdown.sql`:

| Role | On a table or a view of `public` | On a sequence |
|---|---|---|
| `anon`, `PUBLIC` | nothing | nothing |
| `authenticated` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `USAGE` |
| `service_role`, `postgres` | everything | everything |

The same holds for a table `postgres` creates later (default privileges). The block that says so is `TABLE PRIVILEGES` at the end of `schema.sql`. A request without a session is refused by every table — `permission denied for table …` — before a policy is evaluated; a signed-in user cannot `TRUNCATE` (which row-level security does not see), rebuild a table or attach a trigger to one.

Add to the end of item 1 under "**When you add a table**" (as `docs/_pending/sql-02-function-grants.md` leaves it):

The table enables row-level security in the migration that creates it, with its `REVOKE ALL … FROM PUBLIC, anon, authenticated` and `GRANT SELECT, INSERT, UPDATE, DELETE … TO authenticated` next to it, and is defined above the `TABLE PRIVILEGES` block of `schema.sql`; a view is created `WITH (security_invoker = true)`. `supabase/tests/table-acl.test.js` fails otherwise, and `supabase/tests/rls-matrix.test.js` until the table has its insert probe.

## README.md — Database Tests

Replace the file and test counts of the sentence that starts "A run reports" (as `docs/_pending/sql-08c-ensure-claim-rpcs.md` leaves it) with the counts of the wave-1 gate run. This package adds one file and 33 tests (30 in `table-acl.test.js`, 3 for the migration in `migration-conventions.test.js`): 25 files and `931 passed` in the sql lane's worktree, with no expected failure.

Add after the bullet that starts "- `ensure-claim.test.js` holds" (the one `docs/_pending/sql-08c-ensure-claim-rpcs.md` adds):

- `table-acl.test.js` holds who holds what on a table: nothing for `anon` or `PUBLIC`, `SELECT`, `INSERT`, `UPDATE` and `DELETE` for a signed-in user, everything for the service role — and row-level security on every table, `security_invoker` on every view. A migration that adds a table changes nothing in it unless the table must give a signed-in user less (`LESS_FOR_USERS`); it fails on a table without row-level security. The finding is run on the frozen baseline as the role an API request arrives as: `truncate public.profiles cascade` goes through before the migration, for `anon` and for an athlete, and is refused after.

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `ensure-claim.test.js` (the one `docs/_pending/sql-08c-ensure-claim-rpcs.md` adds):

`table-acl.test.js` (who holds what on the tables of `public`: nothing for `anon`/`PUBLIC`, `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `authenticated`, everything for `service_role`; row-level security on every table, `security_invoker` on every view; a table created later starts with the same; every table sent every statement by `anon`, an athlete and the coach; migration `2026_10_13_14_table_grants_lockdown.sql` tried on the frozen baseline — one `TRUNCATE … CASCADE` empties the database before, for `anon` and for an athlete, and is refused after — with the audit table and the checks of its runbook page read off the page)

## CLAUDE.md — When you add a feature

Add to step 2, after the sentence that starts "A function that is created or re-created follows" (the one `docs/_pending/sql-02-function-grants.md` adds):

A table that is created follows "A migration that creates a table, a view or a sequence" in the same file: row-level security and its policies in the migration that creates it, its `REVOKE`/`GRANT` next to it there, its definition above the `TABLE PRIVILEGES` block at the end of `schema.sql` (the only place that grants on a table there), never a grant to `anon`, and an insert probe in `supabase/tests/rls-matrix.test.js`.

## docs/RUNBOOK.md — new section "Checkpoint A3 — …", after the section of Checkpoint A2

Add when Checkpoint A3 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 14, the last of the checkpoint, every command taken from `docs/runbook/migrations/14-table-grants-lockdown.md` as it stands there, one per fence:

1. the audit of migration 14 — it reads as the "before" column of the page's table. **Line 4 must read `none`**: otherwise stop and report, the migration refuses to run. **Lines 2, 3 and 5 are noted**: a table, a view or a sequence the repository does not know, or a table without row-level security, stops nothing and is reported;
2. the migration;
3. the audit again — lines 6 and 8 read `none`, lines 13 and 14 as the "after" column, and **line 7 reads what it read in step 1, `none`**: a name that was not there before is a table the app can no longer read or write, and means roll back;
4. the ledger: fourteen rows, the last one `2026_10_13_14_table_grants_lockdown`;
5. the page's check as `anon`, which must fail with `permission denied for table profiles`;
6. the page's check as a signed-in role, which must not fail;
7. the smoke check in the app that is deployed, as an athlete and as the coach (step 5 of the page's "After").

Name the rollback file, `supabase/rollbacks/2026_10_13_14_table_grants_lockdown.down.sql`, and when it is run: any `permission denied for table …` in steps 3, 6 or 7. Say in the words of its page that it reopens the finding. Link the page as `](runbook/migrations/14-table-grants-lockdown.md)`.

Say once, in the rules that hold at every checkpoint or in this section, next to the sentence about a function created by hand: from this migration on, a table created by hand in the SQL editor cannot be reached without a session, and is read and written in full by every signed-in user until `alter table … enable row level security` is run on it and its policies are written; after creating one, the audit of migration 14 is run again and its lines 5 and 6 must read `none`.
