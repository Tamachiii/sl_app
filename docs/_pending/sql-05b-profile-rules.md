# sql-05b-profile-rules — docs to fold (wave 1, items P20, B10)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace the bullet that starts "**`profiles.full_name` is self-editable; `id`, `role`, `created_at` are pinned.**" with:

- **`profiles.full_name` is self-editable; `id` and `created_at` are pinned for everyone, `role` for every request that carries a user id.** The `Users update own profile` policy lets a signed-in user UPDATE their own row — every column of it — and the `profiles_pin_immutable_columns` BEFORE UPDATE trigger is what keeps the role out of their hands: when `auth.uid()` is not NULL it puts `role` back, **silently** (the rename in the same payload is saved, no error — read the row, not the row count). "With a user id" is the request, not the role the statement runs as: a `SECURITY DEFINER` function called from the app is still that user and writes no role either. Without a user id — the SQL editor, `supabase db query`, the service-role key — the role is written (migration `2026_10_11_07_profile_rules.sql`, review P20: the pin used to apply to every caller, so the documented promotion answered `UPDATE 1` and did nothing). A request without a session is not such a caller: `anon` has no policy on `profiles` and reaches no row — which is the only thing that holds it, so never give `anon` an UPDATE policy there. If a future Profile feature needs to mutate a new column, the policy already allows it; a new column the user must NOT write (anything role-adjacent) has to be added to that trigger function, or it is theirs. `supabase/tests/profiles.test.js` holds it.
- **A role change never contradicts who coaches whom.** The same trigger refuses, with `23514` and a sentence, to make a coach of an account that is somebody's athlete (`students.profile_id`) and to take the role from a coach who has athletes (`students.coach_id`). It is the rule of `trg_check_students_link` — every link joins a `coach` to a `student` — asked when the other side of it moves; without it the promotion that now works would be a way to write exactly the rows that gate refuses. Raised, not silent: the caller is the owner. Consequences: the role comes first and the links after it (a fixture promotes, then links — `createUser({ role: 'coach' })` in `supabase/tests/harness.js`); an athlete with logged training cannot become a coach on the same account (their link cannot be deleted), a coach gets an account of their own; a coach is made an athlete again only once their athletes have moved. KNOWN residual gap: the two triggers read each other's table without a lock, so a link written and a role changed in two transactions at the very same moment can pass each other. Both are owner-only writes.

Replace the bullet that starts "**Signups are always `role='student'`** (2026_07_12)" with:

- **A new account is always `role='student'`, and always has a name.** `handle_new_user` (the `on_auth_user_created` trigger on `auth.users`) never reads the role from the sign-up metadata — the anon key is public, so that metadata is attacker-controlled (2026_07_12) — and stores a `full_name` that is never empty (migration `2026_10_11_07_profile_rules.sql`, review B10): `raw_user_meta_data->>'full_name'` without the white space around it, else the part of the e-mail address before the `@`, else `'Athlete'`. An account made with *Add user* in the dashboard carries no name at all, and an empty one passes every `COALESCE(name, 'Your athlete')` of the push triggers: the coach read " completed Session 3". The function runs inside the INSERT that creates the account, so it **must never raise and never produce NULL** (`profiles.full_name` is NOT NULL), and it **must stay `SECURITY DEFINER`** (the INSERT is GoTrue's, which holds nothing on `public`): either mistake closes account creation for everyone ("Database error saving new user"). The migration does not write the trigger on `auth.users` — the table is the platform's — and refuses to run where no trigger calls the function. KNOWN residual gaps: (1) the profiles created before the migration keep their empty name until somebody types one (`docs/runbook/migrations/07-profile-rules.md`, "Accounts without a name"; line 10 of its audit counts them); (2) nothing stops a user from saving a name of blanks through the API — the app does not send one — and the push triggers still read `COALESCE(name, …)`.
- **A coach is made by the owner of the database, with one statement, and by nobody else.** `update public.profiles set role = 'coach' …` from the SQL editor (the statement, by e-mail address, and what it answers: `docs/runbook/migrations/07-profile-rules.md`, "Making a coach"). The app has no screen for it and no API path reaches it: there is no RPC for it on purpose — a function that changes a role is called without a user id or changes nothing. Each coach is a tenant of their own: a new coach starts with an empty roster and an empty library, and sees nothing of another coach's.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "**Rows two sides write.**" (the one `docs/_pending/sql-05a-pin-student-writes.md` adds):

**Accounts, names and roles.** An account is a row of `auth.users`, created by GoTrue — the dashboard's *Add user*, later an invitation; public sign-up is off. The `on_auth_user_created` trigger calls `handle_new_user`, which writes the `profiles` row: `role = 'student'`, and a `full_name` that is never empty (the name in the user metadata, else the part of the address before the `@`, else `'Athlete'`). Everything else follows from two writes only the owner of the database makes, in the SQL editor: `profiles.role = 'coach'` makes a coach, and a row of `students` gives a coach an athlete. `profiles_pin_immutable_columns` keeps the role for every request that carries a user id and refuses a role change that a `students` row stands against; `trg_check_students_link` refuses a link whose two sides do not have the roles. So `profile.role` — the one gate of the client — and `is_coach()` — the one the policies ask — can only be moved by the owner, and the two tables cannot be brought to disagree from either side.

## CLAUDE.md — Feature → files map

Add a row after the row "Supabase Auth settings (dashboard-only: sign-up off, site URL, redirect list, password length)":

| Accounts: the name of a new one, who is a coach (owner-only, by SQL) | `supabase/schema.sql` (`handle_new_user` — the profile of a new account, `role = 'student'`, a name that is never empty: metadata `full_name`, else the part of the address before the `@`, else `'Athlete'`; `profiles_pin_immutable_columns` — `id`/`created_at` for everyone, `role` for a request with a user id, and a role change refused against a `students` link), migration `2026_10_11_07_profile_rules.sql`, `docs/runbook/migrations/07-profile-rules.md` ("Making a coach", "Accounts without a name" — the owner's statements), `docs/runbook/migrations/05-students-role-gate.md` ("Linking an athlete to a coach"), `supabase/tests/profiles.test.js`, `supabase/migrations/README.md` ("A migration that touches `profiles`, a role or the creation of an account"). The client only reads: `hooks/useAuth` (`profile.role`), and renames through `updateProfile({ full_name })` |

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `pins.test.js` (the one `docs/_pending/sql-05a-pin-student-writes.md` adds):

`profiles.test.js` (the two rules of `profiles`: a new account created as GoTrue creates it — with a name, a blank one, none, no metadata, no address — always gets a name and the role `student`; the role is written by the owner and the service role, kept for a signed-in user, for a coach on an athlete and for a `SECURITY DEFINER` function a user calls, and refused against a coach–athlete link; a second coach made by SQL sees nothing of the first; migration `2026_10_11_07_profile_rules.sql` tried on the frozen baseline — findings before, closed after, back after its rollback — with the audit table, the check and the statements of its runbook page read off the page)

## README.md — Deployment

Replace, in the paragraph that starts "**Auth hardening note:**", "signups always get `role='student'` (`handle_new_user` no longer trusts signup metadata); promote a coach manually via `UPDATE public.profiles SET role='coach' WHERE id = …`." with:

every new account gets `role='student'` (`handle_new_user` does not trust sign-up metadata) and a name that is never empty — the one it was created with, else the part of its e-mail address before the `@`. A coach is made by the owner, in the SQL editor: the statement is in [docs/runbook/migrations/07-profile-rules.md](docs/runbook/migrations/07-profile-rules.md), "Making a coach". No signed-in user changes a role, and the database refuses to make a coach of an account that is somebody's athlete.

The sentence `docs/_pending/sql-04-students-role-gate.md` adds ("An athlete is linked to a coach by the owner …") goes right after this one.

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 15 files and `523 passed | 1 expected fail`.

Add after the bullet that starts "- `pins.test.js` holds the rule" (the one `docs/_pending/sql-05a-pin-student-writes.md` adds):

- `profiles.test.js` holds the two rules of `profiles`: a new account always has a name, and a role is written by the owner of the database only. An account is created there the way production creates one — `asPlatformRole('supabase_auth_admin', …)`, an `INSERT` into `auth.users` made as GoTrue with its own `search_path` — because the function behind it is the one piece of the schema that runs for a role holding nothing on `public`. Since this package `createUser()` without a `fullName` gives a profile named after the address (`alex` for `alex@sl.test`), and `createUser({ role: 'coach' })` promotes with the plain `UPDATE` the owner runs; a fixture that needs an account with an empty name writes it (`update public.profiles set full_name = ''`), as `auth-accounts.test.js` does for the accounts made before the migration.

Add to the list "**Limits of the shim.**", after the bullet that starts "- `postgres` reaches `storage.objects` policies":

- `postgres` does not own `auth.users` here either, and cannot drop or disable a trigger on it. A test that needs the table without `on_auth_user_created` drops the function with `CASCADE` and creates it again (`profiles.test.js`, "where nothing gives a new account its profile …"). Whether `postgres` may create a trigger on `auth.users` in production today is the platform's decision, and nothing here tests it: a migration never re-creates that trigger.

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 07, after the steps of migration 06, every command taken from `docs/runbook/migrations/07-profile-rules.md` as it stands there, one per fence:

1. the audit of migration 07 — it reads as the "before" column of the page's table. **Line 2 must read `in place`**: otherwise stop, the migration refuses to run. Line 10 is `0`, or is noted and does not stop anything;
2. the migration;
3. the audit again — lines 3, 5 and 6 read as the "after" column, and **line 2 still reads `in place`**;
4. the page's check, which must fail with `check only, nothing was written: a new account without a name is called "sl-check-07"; you can make it a coach: yes; signed in, it can make itself one: no` — `YES` means roll back, `NOT TRIED` or a message that does not start with `check only` means stop and report;
5. the smoke check in the app that is deployed, as the test athlete (step 4 of the page's "After": the name changed in Profile, and changed back), only once step 4 above answered as written;
6. if line 10 of the audit was not `0`: the page's section "Accounts without a name" (the list, then one of the two statements), and the audit once more — line 10 reads `0`.

Add to the rules of the index, or to the first-push checklist, two lines: from migration 07 on, a coach is made with the statement of that page ("Making a coach") — the app has no screen for it, and the role comes before the athletes are linked ([05](runbook/migrations/05-students-role-gate.md), "Linking an athlete to a coach"); and an account created in the dashboard is named after the first part of its address until its owner, or you, gives it a name.
