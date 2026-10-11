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
