# supabase/migrations — how a database change is written

Production gets its SQL by hand, one file at a time. The database tests load `supabase/schema.sql`. Two things keep those from drifting apart, and both are tested (`npm run test:db`):

- **the ledger** — `app_private.app_migrations` holds the name of every applied migration, so a file can refuse to run twice or out of order, and a deploy can check what production has;
- **parity** — the frozen production baseline (`supabase/tests/fixtures/prod_baseline_2026_09_30.sql`) plus every migration of `manifest.json` must give exactly the catalog of `schema.sql`.

The files dated before `2026_10` are history: production has them, they cannot be replayed in order, nothing reads them. Do not edit, rename or imitate them.

## A migration is five things, in one commit

| File | Rule |
|---|---|
| `supabase/migrations/YYYY_MM_DD_NN_<name>.sql` | the change. `DD` is the day it is committed, `NN` its number in the global order (two digits, the next free one — or the one the plan gave it) |
| `supabase/audits/<same name>.audit.sql` | **one** read-only query returning **one** table: what to look at before applying, and again after. It must run on a database that does not have the migration yet |
| `supabase/rollbacks/<same name>.down.sql` | undoes the migration and removes its ledger row |
| `docs/runbook/migrations/NN-<name-with-dashes>.md` | for the person applying it: what it does, what a clean audit looks like and what to do when it is not, the three commands, when to roll back, what the deployed client does differently. Copy the layout of `01-migration-ledger.md` |
| an entry in `manifest.json` | see below |

and the same change **merged into `supabase/schema.sql`**: edit the object where it is defined (or append a section), and add the migration's name to the `INSERT INTO app_private.app_migrations` list at the end of that file. `schema.sql` stays the install path of a new database and the file every other test runs against.

Then `npm run test:db`. `parity.test.js` says what one file has and the other has not; `migration-conventions.test.js` says which rule a file breaks.

## manifest.json

```json
{
  "name": "2026_10_03_01_migration_ledger",
  "kind": "required",
  "wave": 0,
  "checkpoint": "A0",
  "covers": ["L26", "P69"],
  "reversible": true,
  "summary": "One sentence: what the database has afterwards."
}
```

Entries are in apply order. `manifest.js` reads the file and derives the four paths from the name.

- **`kind`**
  - `required` — the client of its wave needs it: it must be in production's ledger before that client is deployed.
  - `optional` — may be skipped (it needs an extension, or only pays off under load). Still merged into `schema.sql`.
  - `contract` — removes something an old client still uses. Applied long after the deploy, and **not merged into `schema.sql` until it has been applied**: until then `schema.sql` must keep describing production.
- **`checkpoint`** — when the user applies it (`A0`, `A1`, … `Z`; `docs/RUNBOOK.md`).
- **`reversible`** — `true`: the rollback gives back exactly the catalog the migration started from, and the test checks it. `false` only when that is impossible (a new enum value cannot be removed); the rollback must still remove the ledger row and leave a database the migration can be applied to again. It is about the catalog: rows a migration deletes or rewrites do not come back with a rollback, and the runbook page must say so.

**What a migration requires.** The nearest migration before it that nobody may skip: the nearest `required` one. A `contract` migration requires the nearest `required` or `contract` one. So a required migration never depends on an optional one being there — not by its guard, and not by what it uses: the test applies the list once more with the optional ones left out.

## The migration file

```sql
-- NN — <title>
-- wave W · Checkpoint X · required · findings P.., L..
-- What it does and why; what an old client sees.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '<this name>') THEN
    RAISE EXCEPTION 'migration <this name> is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '<the one it requires>') THEN
    RAISE EXCEPTION 'migration <this name> needs <the one it requires>, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;
END
$guard$;

-- … the change …

INSERT INTO app_private.app_migrations (name)
VALUES ('<this name>')
RETURNING name, applied_at;

NOTIFY pgrst, 'reload schema';

COMMIT;
```

The rules the test holds, in the order of the file:

1. `BEGIN;` is the first statement and `COMMIT;` the last; no other transaction statement in between, nothing after. One file, one transaction: applied completely or not at all.
2. `SET LOCAL lock_timeout` is the second statement. A migration that cannot get its lock within seconds gives up instead of queueing every request of the app behind it.
3. The guard is the third statement. It names the migration and raises `SLM01` when it is already in the ledger; it names the migration it requires and raises `SLM02` when that one is missing. It runs before anything is touched.
4. The migration inserts its own name into the ledger, inside the transaction.
5. `NOTIFY pgrst, 'reload schema';` whenever the migration adds, removes or changes a table or a column of `public`, a primary key, a unique constraint or a foreign key of a `public` table, or anything in the header of a `public` function (arguments, return type, volatility, `SECURITY DEFINER`, `SET` clauses) — PostgREST caches those; the foreign keys are how it knows what can be embedded in what. Not needed for a function body, a policy, a trigger, an index, a check constraint. The rollback file follows the same rule: when it changes any of those back, it carries the `NOTIFY` too.

## A migration that creates or re-creates a function

Since migration 03 no function of `public` is executable by `anon` or by `PUBLIC`, a signed-in user executes an explicit allow-list, and a function `postgres` creates starts closed: its owner and `service_role`, nobody else. `supabase/tests/function-acl.test.js` holds each of the rules below against the catalog, for every function there is.

1. **`SET search_path = public, pg_temp` in the definition**, in the migration and in `schema.sql` alike, and every name in the body written with its schema. `CREATE OR REPLACE` drops a `SET` clause the new text does not repeat — and keeps the grants.
2. **In the migration, the privileges stand next to the function**, so that the result does not depend on the default privileges of the database the file runs in:

   ```sql
   REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon, authenticated;
   GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;   -- only when rule 4 says so
   ```

3. **In `schema.sql`, the grant goes into the `FUNCTION PRIVILEGES` block at the end of the file, and nowhere else.** That block takes everything back from `PUBLIC`, `anon` and `authenticated` and then grants the allow-list: a `GRANT` written next to the function would be undone by it. The block stays below every function: nothing after it creates one.
4. **Who gets the grant.** `authenticated`, when a policy calls the function (a policy runs with the privileges of the user who queries the table — so does a column default, a check constraint, a view, the expression of an index) or when the app calls it with `supabase.rpc()`. Nobody, for a trigger function: a trigger fires whatever the privileges of the user whose statement fires it. Nobody either for a function that only an Edge Function, a cron job or another `SECURITY DEFINER` function calls. Never `anon`.
5. **The function joins a list of `function-acl.test.js`** — `HELPERS`, `RPCS`, or `NOT_FOR_USERS` with the reason; a trigger function joins none. The test fails until it does.

## A migration that deletes or rewrites training rows

Since migration 04 a set the athlete has logged — `public.set_log_is_logged(sl)`: done, failed, skipped, an RPE or an actual — or one with a video cannot be deleted, from `set_logs` up to `programs`, and a cascade that reaches one raises (`… logged set …`). `supabase/tests/history-guards.test.js` holds it.

- **A migration that must delete such rows** says so, right before the statement that needs it:

  ```sql
  SET LOCAL app.allow_history_delete = 'on';
  ```

  It lasts until `COMMIT` and is read only when the statement comes without a user id — which is how a migration runs. The header of the file says what is deleted, and the runbook page that the rows do not come back with the rollback.
- **A function that must** (erasing an account) calls `set_config('app.allow_history_delete', 'on', true)` itself, is executable by the service role only, and never by `authenticated`: with a user id the setting is ignored.
- **Never** drop or disable one of the guard triggers to get a delete through.
- **An `UPDATE` of `target_*`** by a migration is written to logged sets too: the pin (`trg_pin_logged_set_log_targets`) is for a signed-in user. Add `WHERE NOT public.set_log_is_logged(sl)` unless rewriting what was lifted is the point of the migration.
- **"Already trained"** is spelled `public.set_log_is_logged(sl)` wherever SQL needs it — never the six columns again.

## A migration that touches who coaches whom, a library or a slot

Since migration 05 `public.students` — the table every "Coaches …" policy reads — is written by the owner of the database only, and three triggers judge what is written, **for every writer: a migration and a `SECURITY DEFINER` function included**. `supabase/tests/students-gate.test.js` holds it.

- **A link** (`INSERT` into `students`, or an `UPDATE` of `profile_id` / `coach_id`) joins a profile with the role `coach` to another one with the role `student`, or `trg_check_students_link` raises `23514`. With a user id the link does not move at all (`42501`), whatever role the statement runs as: a function that moves an athlete is not granted to `authenticated`, and is called from the SQL editor or with the service-role key.
- **Never an `INSERT` or a `DELETE` policy on `students`**, and never a policy that lets a coach write on `coach_id = auth.uid()` alone: any account can put its own id in that column. A policy that lets a COACH write a row asks for the role next to the ownership:

  ```sql
  WITH CHECK (coach_id = auth.uid() AND (SELECT public.is_coach()))
  ```

  Written as a sub-select, it is asked once per statement. Keep it out of a `USING` that a `SELECT` goes through (a `FOR ALL` policy): `is_coach()` is not executable without a session, and a read that answered "no rows" would answer `permission denied for function is_coach`.
- **An exercise** written into `exercise_slots.exercise_id` or `slot_deviations.substitute_exercise_id` is in the library of the program's coach (`students.coach_id` of the athlete the program belongs to), or the trigger raises `23514` (`… is not in the library of the coach of this program`). It is asked on `INSERT` and when the exercise changes — so a function that COPIES slots is asked for every copy, and must decide what it does with a slot that holds another coach's exercise (an athlete who changed coach) before it inserts: leave it out and say so, not fail half-way.
- **Never** drop or disable one of the three triggers to get a row through. A row the gate refuses is a row that should not be written.

## A migration that adds a column to `set_logs`, `sessions` or `programs`

Three tables hold rows that an athlete may write and that carry columns which are not theirs. Row-level security says who may write the row; since migration 06 a `BEFORE` trigger puts the other side's columns back — **silently**: the statement is accepted, the rest of the write is saved, the held columns keep their values. `supabase/tests/pins.test.js` holds it.

| Trigger function | Holds | For whom |
|---|---|---|
| `pin_set_log_targets_for_student` (`set_logs`, update) | `target_*`, `is_student_added`, `exercise_slot_id`, `set_number` | the athlete of the set, asked of `OLD.exercise_slot_id` |
| `pin_draft_session_columns` (`sessions`, insert and update; `STABLE`) | `reviewed_at`, `archived_at`, `performed_at`, `scheduled_date` — set to NULL | everyone, while the program is a draft |
| `pin_program_authoring_columns` (`programs`, update) | `created_by`, `student_id` for everyone; `status`, `approved_at`, and `submitted_at` once it is set, for the author of the draft | see left |

- **A new column joins the list of its table, or the hole is back.** On `set_logs`: a column that says what the set IS — a prescription, a link to another row — is held; one that records what the athlete did is not. On `sessions`: a column that records what happens to a session once its program is trained — a check-in, a review signal — is held, and is added to the `UPDATE` of `approve_program` that clears the four.
- **`CREATE OR REPLACE` replaces the whole body — and the words after it.** Copy the function from `schema.sql`, add the line, keep `SET search_path`, the `REVOKE` and, on `pin_draft_session_columns`, `STABLE`. A list retyped from memory is a list one column short.
- **`pin_draft_session_columns` is `STABLE`, and without the keyword the hole is back.** Two things judge a write to a session of a draft: the policy that lets the author write it (`week_is_own_draft`, `STABLE`) and the pin. A `STABLE` function reads the database as the statement that called it saw it when it started; a `VOLATILE` one reads it as it is by the time the row is reached. They disagree when the coach approves while a stamp of the author waits for a row lock — a draft for the policy, an approved program for a `VOLATILE` pin, which holds nothing — and the stamp is written on the approved program. An author gets there with the API alone, by sending the stamps on a few connections at once. **No test on one connection fails**; `pins.test.js` has the one on three ("a stamp on its way while the coach approves …"). A new trigger that judges a row by something a policy of the same table also judges takes the volatility of that policy's helper. The price: a `STABLE` trigger function does not see a row created earlier in the SAME statement (a data-modifying CTE that inserts the week and its session). The policies do not see it either, so that write is refused to the author and to the coach; a caller row-level security does not apply to — the owner, the service role — gets a stamped session into a draft that way, until the session is next written.
- **A pin on `sessions` is keyed on the status of the program, never on who writes.** `sessions.performed_at` is written by `sync_session_performed_at`, a `SECURITY DEFINER` trigger that runs inside the athlete's own request, on a program the athlete may have authored: "for the athlete" or "for the author" undoes that write.
- **A `SECURITY DEFINER` function called by the athlete is the athlete for these triggers** — `auth.uid()` is theirs. One that must write a held column of a set on their behalf cannot do it with an `UPDATE`.
- **A test about a pin reads the row back.** No error is raised, and an `UPDATE … RETURNING` answers the row as it is stored.

## A migration that brings a rule the rows already there may break

A trigger or a policy judges what is written after it. When rows that are already in the database break the rule **and leaving them would leave the hole in use**, the migration refuses to start:

- its guard counts them and raises `SLM05` (`REFUSAL.rowsInTheWay`) before anything is touched, naming the first five and the runbook page. It takes the lock that keeps the table as counted until `COMMIT` (`LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`, the lock `CREATE TRIGGER` asks for anyway);
- the audit has a line that counts the same rows with the same condition, and says that it must read `0`;
- the runbook page gives the statement that lists them, says what each kind of row means, and gives the statement that removes ONE. The migration does not delete them itself: it cannot tell a forged row from a mistake the owner wants to repair;
- the test puts such rows into the baseline, follows the page to the letter, and applies the file.

Rows that break the rule and do no harm stay where they are: the audit counts them on lines that stop nothing, the page says what each one means, and the rule is written so that they can still be edited (migration 05: audit lines 12 to 14, and "asked when the row is created or the exercise changes").

## The rollback file

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '<this name>') THEN
    RAISE EXCEPTION 'migration <this name> is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
END
$guard$;

-- … undo the change: drop what was created, re-create what was replaced
--    with the text it had before (copy it from the baseline or from the
--    migration that last wrote it) …

DELETE FROM app_private.app_migrations WHERE name = '<this name>';

NOTIFY pgrst, 'reload schema';

COMMIT;
```

Same transaction rules. Raise `SLM04` when a later migration still needs what the rollback would remove.

## What the test does with each migration

On a database built from the production baseline, in manifest order, for every entry:

1. runs the audit in a read-only transaction — it must not write, and must not fail;
2. removes the required migration from the ledger and runs the file — it must refuse with `SLM02` and change nothing;
3. applies it — it must be in the ledger; if a table, a column, a key or a function header of `public` changed, the file must carry the `NOTIFY`;
4. applies it again — it must refuse with `SLM01` and change nothing;
5. runs the audit again;
6. rolls it back — the ledger row is gone, and (when `reversible`) the catalog is the one from before step 3, object for object; if that changed what step 3 looks at, the rollback file must carry the `NOTIFY`;
7. rolls it back again — it must refuse with `SLM03`;
8. applies it again — the catalog is the one from after step 3.

Then, on a second copy of the baseline, it applies every migration that is not `optional`, in order: each must go through without the optional ones before it.

"The catalog" is everything `supabase/tests/catalog.js` reads: tables, columns, constraints, indexes, triggers, policies, functions with their settings and privileges, types, default privileges, publications, comments, and the rows SQL files insert. A migration that seeds a table adds it to `REFERENCE_DATA` there, with the columns to compare; the parity test refuses rows in a table that is not listed, because all it could compare is how many there are.

A migration that changes what a role can do also changes `supabase/tests/snapshots/rls-matrix.txt`. Regenerate it (the command is in the file) and commit the diff with the migration: each changed cell is the change, in one line.

## Applying to production

Never from here. The user applies the files by hand: `docs/runbook/00-before-you-start.md`.
