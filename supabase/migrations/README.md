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
  - `optional` — may be skipped (it needs an extension, or only pays off under load). Still merged into `schema.sql` — one that names an `extension`, inside a block that runs only where the project has it.
  - `contract` — removes something an old client still uses. Applied long after the deploy, and **not merged into `schema.sql` until it has been applied**: until then `schema.sql` must keep describing production.
- **`checkpoint`** — when the user applies it (`A0`, `A1`, … `Z`; `docs/RUNBOOK.md`).
- **`extension`** — on an `optional` migration only, and only when it needs one: the extension the owner of the project must have switched on before the file runs (`"extension": "pg_cron"` — `EXTENSIONS` in `manifest.js` is the list). Left out everywhere else: pg_net and the vault are in every project. It is what the tests go by to know which of two projects a migration belongs to: ["A migration that needs an extension the project may not have"](#a-migration-that-needs-an-extension-the-project-may-not-have), below.
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
5. **The function joins a list of `function-acl.test.js`** — `HELPERS`, `RPCS`, or `NOT_FOR_USERS` with the reason; a trigger function joins none. The test fails until it does. The one exception is a function of a migration that names an `extension`: it is not in the database that file runs on, and the test of its migration holds the same three things — who may execute it, with whose rights it runs, its `search_path` (`record_push_failures()` in `cron-jobs.test.js`).
6. **A migration that refuses to replace a function whose text it does not know compares the text production holds**, not only the one of `schema.sql`. Production was given each function by the file that wrote it last, and for about twelve functions that text differs from `schema.sql` and from the frozen baseline by its comments (L29, the header of `supabase/tests/fixtures/prod_baseline_2026_09_30.sql`). The guard and the line of the audit then hash the text without its `--` comments, spaces folded — `md5(btrim(regexp_replace(regexp_replace(prosrc, '-{2}.*', '', 'gn'), '[[:space:]]+', ' ', 'g')))`, as migration 21 does for `save_draft_tree`, given to production by `2026_08_22_draft_day_number_optional.sql`. Hashing with the comments is enough only where that file and the baseline hold the same text — `lock_message_fields_on_update` of migration 24 (`2026_04_30_message_session_ref.sql`), or a function of a migration of `2026_10` that production was given as it is (`approve_program` of migration 15, for migration 20). A test runs that file on the baseline before the migration, and the migration takes what it left (`small-hardening.test.js`, "takes the save_draft_tree production was given").

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
| `pin_draft_session_columns` (`sessions`, insert and update; `STABLE`) | `reviewed_at`, `archived_at`, `performed_at`, `scheduled_date` — set to NULL | everyone whose write reaches it, while the program is a draft: the author, the owner, the service role. The coach's write on a draft is refused before it, since migration 20 |
| `pin_program_authoring_columns` (`programs`, update) | `created_by`, `student_id` for everyone; `status`, `approved_at`, and `submitted_at` once it is set, for the author of the draft | see left |
| `stamp_program_deactivated_at` (`programs`, insert and update; migration 17, `replay-grace.test.js`) | `deactivated_at` — which it also writes itself, when a block is switched off or on | every request that carries a user id |

- **A new column joins the list of its table, or the hole is back.** On `set_logs`: a column that says what the set IS — a prescription, a link to another row — is held; one that records what the athlete did is not. On `sessions`: a column that records what happens to a session once its program is trained — a check-in, a review signal — is held, and is added to the `UPDATE` of `approve_program` that clears the four. On `programs`: the author of a draft writes every column of the row of their draft that no trigger puts back, and the row is still theirs to have written once the coach approves it — a column that says what the athlete may do with the block, or what became of it, is held for them (`deactivated_at` is the example: "A migration that changes when an athlete may write in a block", below).
- **`CREATE OR REPLACE` replaces the whole body — and the words after it.** Copy the function from `schema.sql`, add the line, keep `SET search_path`, the `REVOKE` and, on `pin_draft_session_columns`, `STABLE`. A list retyped from memory is a list one column short.
- **`pin_draft_session_columns` is `STABLE`, and without the keyword the hole is back.** Two things judge a write to a session of a draft: the policy that lets the author write it (`week_is_own_draft`, `STABLE`) and the pin. A `STABLE` function reads the database as the statement that called it saw it when it started; a `VOLATILE` one reads it as it is by the time the row is reached. They disagree when the coach approves while a stamp of the author waits for a row lock — a draft for the policy, an approved program for a `VOLATILE` pin, which holds nothing — and the stamp is written on the approved program. An author gets there with the API alone, by sending the stamps on a few connections at once. **No test on one connection fails**; `pins.test.js` has the one on three ("a stamp on its way while the coach approves …"). A new trigger that judges a row by something a policy of the same table also judges takes the volatility of that policy's helper. The price: a `STABLE` trigger function does not see a row created earlier in the SAME statement (a data-modifying CTE that inserts the week and its session). The policies do not see it either, so that write is refused to the author — and to the coach, whose week is refused already (migration 20); a caller row-level security does not apply to — the owner, the service role — gets a stamped session into a draft that way, until the session is next written.
- **A pin on `sessions` is keyed on the status of the program, never on who writes.** `sessions.performed_at` is written by `sync_session_performed_at`, a `SECURITY DEFINER` trigger that runs inside the athlete's own request, on a program the athlete may have authored: "for the athlete" or "for the author" undoes that write. (`block_draft_tree_write`, migration 20, does ask who writes — on a DRAFT only, which is never trained: no confirmation reaches one.)
- **A `SECURITY DEFINER` function called by the athlete is the athlete for these triggers** — `auth.uid()` is theirs. One that must write a held column of a set on their behalf cannot do it with an `UPDATE`.
- **A test about a pin reads the row back.** No error is raised, and an `UPDATE … RETURNING` answers the row as it is stored.

## A migration that touches `profiles`, a role or the creation of an account

Two functions stand behind every row of `public.profiles`, and since migration 07 each has a rule a later `CREATE OR REPLACE` must keep. `supabase/tests/profiles.test.js` holds them.

- **`handle_new_user` runs inside the `INSERT` that creates the account** (`on_auth_user_created`, on `auth.users`): an error in it is an account that cannot be created — *Add user* in the dashboard, an invitation, a sign-up all answer "Database error saving new user". So it never raises and never stores `NULL`: every step of the name answers `NULL` for a `NULL` and the last one is a constant. It stays `SECURITY DEFINER` — the `INSERT` is GoTrue's, which holds nothing on `public` — and a re-creation that leaves the two words out closes account creation the same way. A column added to `profiles` gets a default, or a value here.
- **The name is never empty**: the name the account was created with (`raw_user_meta_data->>'full_name'`, trimmed), else the part of the address before the `@`, else `'Athlete'`. The push triggers are written with `COALESCE(name, 'Your athlete')`, which an empty string passes. A function that creates accounts (an invitation) sends the name as `full_name` in the user metadata and writes nothing to `profiles` itself.
- **The trigger on `auth.users` is not ours to re-create.** The table is the platform's. A migration replaces the function and refuses to run where no trigger calls it (the guard of migration 07) — it does not `CREATE TRIGGER` on `auth.users`.
- **`profiles.role` is written without a user id, or not at all.** `profiles_pin_immutable_columns` puts the role back — silently — whenever `auth.uid()` is not NULL: the app, the API, and a `SECURITY DEFINER` function called from either, which is still that user. A function that must change a role is therefore not granted to `authenticated`: it is called from the SQL editor or with the service-role key. `id` and `created_at` are put back for everyone.
- **A role that changes is held to the coach–athlete links** (the rule of migration 05, asked from the other side): an account that is somebody's athlete is not made a coach, a coach who has athletes does not stop being one — `23514`, raised. So the order is: the role first, then the links; and the athletes moved before a coach is made an athlete again.
- **A new column of `profiles` that its owner must not write joins that function.** "Users update own profile" lets a signed-in user write every column of their own row: a column the trigger does not put back is theirs.

## A migration that adds something an athlete writes in a session

Since migration 08 an athlete's write to anything that hangs under a session — `set_logs`, `slot_comments`, `slot_deviations`, `set_log_videos`, the files of the `set-videos` bucket — asks three questions. `supabase/tests/session-gates.test.js` holds them.

```sql
public.student_profile_for_slot(x) = auth.uid()     -- the row is mine
AND public.program_active_for_slot(x) = true        -- my program is the block being trained
AND public.session_writable_for_slot(x)             -- its session is neither archived nor reviewed
```

The second one has been wider than its comment since migration 17: the block being trained, **or one that was switched off less than 72 hours ago** — "A migration that changes when an athlete may write in a block", below.

- **`session_writable` is the lock of the SESSION, and nothing else.** A session of a past block, of a trashed block or of a draft answers `true`: whether the program is the one being trained is `program_active_for_session` / `program_active_for_slot`. A policy that asks one and not the other has a hole — and so has a `SECURITY DEFINER` function that writes for an athlete: it goes around the policies, so it asks all three itself.
- **It never answers NULL**: a session, a slot or a set that does not exist is not writable. `IF NOT public.session_writable(x) THEN RAISE` refuses what it should; keep the `COALESCE(…, false)` when the function is re-created.
- **The lock is `reviewed_at`, not the confirmation.** The app queues the sets logged offline one by one and the confirmation separately: a set may arrive after the confirmation of its session, and is accepted until the coach reviews. A rule that closes a session at the confirmation loses those sets.
- **What closes a session is said in `session_writable`, in one place.** A new column that locks a session for its athlete joins that function, not the policies.
- **A new table an athlete writes under a session gets four policies, never `FOR ALL`**: `SELECT` with the first question only — an athlete reads every session they ever trained —, `INSERT` (`WITH CHECK`), `UPDATE` (`USING` and `WITH CHECK`) and `DELETE` (`USING`) with the three. When the table is keyed on a set, the slot is `public.slot_for_set_log(set_log_id)`.
- **A refusal has two shapes.** An `INSERT` — an upsert included, which is judged as the `INSERT` it starts as — raises `42501`. An `UPDATE` or a `DELETE` reaches no row and says nothing. A test about a refused write shows the same statement going through on a session in progress first (`tryAll` in the test file), then reads the rows back.
- **`session_writable(uuid)` is in the allow-list since migration 09**: the `UPDATE` and `DELETE` policies of `session_confirmations` ask it of a session id. A table keyed on a session, not on a slot, asks it the same way, next to `student_profile_for_session` and `program_active_for_session`.
- **A video is stored at `<athlete's profile id>/<exercise slot of its set>/<file>`**, and the row may name no other place (`WITH CHECK` of `set_log_videos`). The storage policies judge a file by the slot its path names — `public.set_video_slot(name)`, which answers NULL for a path of any other shape. Never cast a part of a path to `uuid` in a policy: a path that is not one would fail the statement instead of being refused. Another kind of file in that bucket needs its own policy, or the same layout.
- **The coach is not asked.** The coach's policies do not look at the state of a session, and `adopt_swap`, `adopt_skip` and `decline_promote_request` write `slot_deviations` as `SECURITY DEFINER`: a reviewed session is where they are used.

## A migration that touches a confirmation, a review or a notification

Since migration 09 a confirmation (`session_confirmations`: "I have trained this session") and a review (`sessions.reviewed_at`: "I have read it", with feedback or without) are tied together, and the coach's bell follows what an athlete takes back. `supabase/tests/review-lifecycle.test.js` holds it.

| Rule | Held by |
|---|---|
| a review closes the confirmation | the athlete's `UPDATE` and `DELETE` policies on `session_confirmations` (`session_writable(session_id)`), and the trigger `block_confirmation_delete_when_reviewed` when a `DELETE` and a review cross |
| a review needs a confirmation | the trigger `trg_review_needs_confirmation` on `sessions`, and the `INSERT` policy of `messages` (`session_is_confirmed(session_id)`) |
| what is taken back takes its unread notifications with it | `trg_retract_session_completed_notification` (`session_confirmations`), `trg_retract_slot_deviation_notifications` (`slot_deviations`) |

- **Both rules are for a request that carries a user id** — the app, the API, and a `SECURITY DEFINER` function called from either, which is still that user. The owner of the database and the service role are not judged: removing an account cascades to its confirmations while the sessions are still there, and a review is taken back by hand (`docs/runbook/migrations/09-review-lifecycle.md`). So sessions reviewed without a confirmation exist — from before the rule, and from the SQL editor — and nothing may assume "reviewed, therefore confirmed".
- **A new writer of `sessions.reviewed_at` meets the trigger.** A function that marks sessions as reviewed for a coach — one at a time or many — is refused (`42501`, `… is not confirmed by its athlete …`) for the whole statement as soon as one of them has no confirmation: filter with `EXISTS (SELECT 1 FROM public.session_confirmations …)` and say how many were left out. The trigger judges the transition from NULL to a value only: every other write of a reviewed session goes through, and so does `reviewed_at = NULL`.
- **An `INSERT` of a session is not judged.** A function that copies sessions does not copy `reviewed_at` (nor `archived_at`, `performed_at`): a copy is a session nobody has trained.
- **The `INSERT` policy of `session_confirmations` does not ask about the review, on purpose.** A session reviewed without a confirmation stays in its athlete's list of sessions to do until it is confirmed; that confirmation is then final. Do not "complete" the policy with `session_writable`.
- **`review_needs_confirmation` is `VOLATILE`, and with `STABLE` the hole is back** — the opposite of `pin_draft_session_columns`. A review and an undo sent in the same instant each start before the other is committed. A `BEFORE UPDATE` trigger fires once the row of the session is locked; a `VOLATILE` function then reads `session_confirmations` as it is by then, a `STABLE` one as the statement saw it when it started — with the confirmation that has just been taken back. For the same reason it does not call `session_is_confirmed()`, which is `STABLE` because a policy calls it. `block_confirmation_delete_when_reviewed` is the other order: it reads the session again `FOR SHARE`, which waits for a review that is being written. **No test on one connection fails**; `review-lifecycle.test.js` has three on several ("a review and an undo that cross").
- **`trg_review_needs_confirmation` fires after `trg_pin_draft_session_columns`, because of its name.** `BEFORE` triggers fire in the order of their names, and each sees the row as the one before left it: on a session of a draft the pin has put `reviewed_at` back to NULL when "from NULL to a value" is asked, and the write stays silent. A trigger on `sessions` that must come before either is named accordingly — and a rename is a change of behaviour.
- **The athlete's `UPDATE` policy on `session_confirmations` is there for the app deployed before wave 1**, whose confirm is an upsert that updates. The app of wave 1 inserts or does nothing, and never updates a confirmation. Once no older app is in use, a `contract` migration can drop the policy — and with it the one thing the two triggers do not hold: an `UPDATE` that moves a confirmation to another session (`session_id` is not held on that table) in the same instant as the review leaves a session reviewed without one.
- **A refusal has three shapes here.** An `UPDATE` or a `DELETE` that a policy refuses reaches no row and says nothing. An upsert that meets a row it may not update (`INSERT … ON CONFLICT DO UPDATE`, what the app deployed before wave 1 sends for a confirm) raises `42501` — PostgreSQL never skips that in silence; `ON CONFLICT DO NOTHING` is judged as an `INSERT` only. And the two triggers raise `42501` with a sentence of their own. The app shows all of them as `errors.notAllowed`.
- **A notification about a row that can be taken back names that row in its payload, and gets an `AFTER DELETE` trigger that removes it — unread only.** `session_completed` carries `session_id` and `confirmation_id`; `session_deviation` and `promote_requested` carry `slot_id`. A notification the coach has read is their history and stays. The functions are `SECURITY DEFINER`: the statement is the athlete's, the row is the coach's, and nobody holds a `DELETE` policy on `notifications`.
- **`CREATE OR REPLACE` of `notify_coach_on_session_confirm` keeps the tag `'session-confirm-' || NEW.session_id`.** With the id of the confirmation, which is a new one after each undo, the pushes of one session stack on the coach's lock screen.
- **A migration that deletes notifications says which, and counts them in its audit** (lines 14 and 15 of migration 09): they do not come back with a rollback.

## A migration that adds a foreign key to `profiles` or `exercise_library`, a `coach_id`, or a goal

Since migration 10 what an account or a library exercise takes with it when it is deleted is decided on purpose, and an athlete changes coach through one function. `supabase/tests/goals.test.js` holds it.

- **`ON DELETE` is written for whose row it is.** A row that belongs to the account alone goes with it: `CASCADE` (`students.profile_id`, `goals.student_id`, the athlete's messages and logs). A row that somebody else's training hangs on holds the account: `RESTRICT` — `students.coach_id`, `goals.coach_id`: a coach's account is not deleted while an athlete is linked to it or a goal names it. A new table with a `coach_id` next to a `student_id` follows the same split, and says why if it does not.
- **A library exercise that anything names is not deleted**: `exercise_slots.exercise_id`, `slot_deviations.substitute_exercise_id` and `goals.exercise_id` are `RESTRICT`. A new reference to `exercise_library` is `RESTRICT` too — `23503`, which the app shows as "in use" — and joins the three that `useExerciseUsage` counts. The way out of the pickers is `exercise_library.archived_at`.
- **The database refuses nothing about an archived exercise.** A slot that holds one stays, a new slot can take one, a goal on one is still logged against: "not offered for new work" is the pickers' rule (`isActiveExercise`). A function that copies sessions copies their slots whatever `archived_at` says; a constraint that refused one would break every copy of a block that uses it.
- **`RESTRICT` names the first thing in the way, and which one is first is not ours to choose.** The triggers of the foreign keys on one table fire in the order of their internal names (`RI_ConstraintTrigger_a_<oid>`, compared as text), and a constraint that is re-created gets a new one. Deleting a coach's profile is refused by the link, by a goal, or — when the `DELETE` reaches the library first — by `exercise_slots_exercise_id_fkey`. A test that deletes a profile asserts `23503` and that nothing went, or builds the case in which one key alone is in the way (`goals.test.js` has both); a runbook page says "the message names one of…".
- **Changing what a foreign key does on `DELETE` is `DROP CONSTRAINT` and `ADD CONSTRAINT`, in one `ALTER TABLE`**, under the name it had — PostgREST embeds by that name — after a guard that finds it under that name and finds no second foreign key on the column: one made by hand would go on cascading behind a migration that says it is gone. The statement takes `ACCESS EXCLUSIVE` on the table and on the one it references.
- **"The coach of this athlete" is `students.coach_id`, today.** A column that remembers who wrote a row (`goals.coach_id`) is not who may read what hangs under it: `coach_profile_for_goal(goal)` answers that profile only while `students` still links it to the goal's athlete, and NULL otherwise. A policy for a coach asks the link, directly or through such a helper — never the remembered column alone.
- **An athlete changes coach with `public.transfer_student(athlete profile, new coach profile)`, and with nothing else.** It moves the link and hands the athlete's goals over in one statement; rewriting `students.coach_id` by hand leaves the goals with a coach who can no longer read them. A table that gets a `coach_id` next to a `student_id` **joins the body of that function** — in the migration and in `schema.sql` — or its comment says why the rows stay with the former coach. What the function does not move: the exercises (the slots and the goals keep pointing at the former coach's library), the conversation, the former coach's notifications.
- **`transfer_student` is for a caller without a user id, and has no right of its own.** It is not granted to `authenticated` (it is in `NOT_FOR_USERS` of `function-acl.test.js`), it raises `42501` first thing when `auth.uid()` is not NULL, and it is `SECURITY INVOKER`: the owner and the service role are not held by row-level security, anybody else would be. A function that calls it for a user — an admin screen, later — is an Edge Function with the service-role key, not a `SECURITY DEFINER` wrapper: inside a user's request `auth.uid()` is still that user, and both the function and `trg_check_students_link` refuse.

## A migration that changes which block is active, or the order of sessions or phases

Since migration 11 three functions do in one statement what the app did in several requests: `public.activate_program(p_program_id)`, `public.reorder_sessions(p_week_id, p_ids)` and `public.reorder_weeks(p_program_id, p_ids)`. `supabase/tests/atomic-rpcs.test.js` holds them.

- **They are `SECURITY INVOKER`, and have no rule of their own about who calls.** The policies of `programs`, `weeks` and `sessions` decide: a migration that changes who may write one of those tables changes who gets through these functions, and has nothing to rewrite in them. A caller who reads the parent and may not write it finds no row to lock (`FOR UPDATE` goes through the policies of `UPDATE`) and is told `not authorized` (`42501`); one who cannot read it, `program_not_found` or `week_not_found`. Do not make them `SECURITY DEFINER` to "simplify": the whole ownership walk would have to be written again inside.
- **The header is what the app calls.** PostgREST finds a function by its name and the names of its arguments, and the app reads what it returns: `p_program_id`, `p_week_id`, `p_ids`, `jsonb` for `activate_program` (`program_id`, `student_id`, `already_active`, `deactivated` — keys are added, never renamed), `void` for the two others. `CREATE OR REPLACE` cannot change a return type or the name of an argument, and `DROP` + `CREATE` breaks the app that is deployed between the two: a different contract is a new function under a new name.
- **A unique key that is not deferrable is checked row by row — inside one `UPDATE` too.** `sessions_week_sort_order_unique` and the key on `weeks (program_id, week_number)`: a statement that renumbers parks every row first, **above every number the parent holds** (`GREATEST(max, n) + place`), then places. Parked at a constant — the `100000 + place` of the app before wave 2, which `move_session` still does — a row can meet the one an interrupted reorder left at that number.
- **A list of children is the WHOLE list.** `reorder_sessions` and `reorder_weeks` refuse (`reorder_ids_mismatch`) a list that is not exactly the children of the parent, archived sessions included: a function or a screen that orders sessions sends the archived ones too.
- **The locks are taken from the top down**: the programs of the athlete in the order of their ids (`activate_program`), the program then its phases (`reorder_weeks`), the phase then its sessions in the order of their ids (`reorder_sessions`). A function that inserts, moves or renumbers sessions or phases takes them in that order, or it can deadlock with these. `FOR UPDATE` on the parent is what makes a child that is being added wait: its foreign key asks for the row.
- **Something that must follow a block being switched on or off is a trigger on `programs.is_active`**, not a line in `activate_program`: the app deployed before wave 2 still switches blocks with two `UPDATE`s of its own. `trg_stamp_program_deactivated_at` (migration 17) is the first one.
- **A new state in which a program must not be the active one** (today: a draft, the trash) joins the refusals of `activate_program`, before its first `UPDATE`.
- **The refusals are `P0001` with a fixed word for a message** (`program_is_draft`, `reorder_ids_mismatch`, …) — the API answers `400` for it, and `500` for the codes that would read better (`P0002` `no_data_found`, class `55`) — and the sentences are in `DETAIL` and `HINT`. The app turns an error into a toast by searching message, details and hint together for the names of constraints and for a few phrases (`src/lib/mutationErrors.js`): do not name a constraint in a `DETAIL`, nor write `logged set`, `foreign key` or `permission denied` in one.

## A migration that adds a column to a program, a phase, a session, an exercise slot or a set — or copies one

Since migration 12 four functions make a copy in one statement: `public.duplicate_session(p_session_id, p_title_suffix)`, `public.copy_sessions(p_session_ids, p_dest_week_id)`, `public.duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)` and `public.duplicate_program(p_program_id, p_target_student_id, p_name_suffix)`. `supabase/tests/copy-rpcs.test.js` holds them.

- **A new column of `programs`, `weeks`, `sessions`, `exercise_slots` or `set_logs` is copied, or left behind on purpose — and the test asks which.** `WHAT_A_COPY_IS` at the top of the test file lists every column of the five tables as `copied` or `left`, and its first test fails on a column that is in neither list. A copy is the prescription and nothing of what was trained: what the coach wrote is copied (a target, a note, a number of sets), what happened afterwards is not (done, an RPE, a review, a date of training), and neither is anything the athlete added.
- **A copied column is written in four places that are one text.** The three `INSERT`s that write a copy stand between the marks `-- >>> the copy` and `-- <<< the copy`, the same lines in the four functions, in the migration and in `schema.sql`; the test compares the eight blocks. A migration that makes a copy carry a new column re-creates the four functions (`CREATE OR REPLACE`, with `SET search_path` and the `REVOKE`/`GRANT`, the body copied from `schema.sql`), adds the column to that block in all of them, adds it to the columns its guard asks for, and moves it to `copied` in the test. The rows are read as whole rows (`public.set_logs[]`), so nothing else in the functions names a column of the three tables.
- **What is copied is read in ONE statement, before the first write.** Each statement of a function sees what was committed by then: three `INSERT … SELECT`s from the tables would copy a session as it was, its exercises as they are a moment later and their sets later still — an exercise without its sets when the coach removes a set in another tab. Keep the single `SELECT … INTO` of arrays, and write from the arrays. A copy function that reads a table of the tree after its first write has the hole back; `copy-rpcs.test.js` has the test ("is the block as it was at one instant").
- **They are `SECURITY INVOKER`, like the three of migration 11, and decide nothing about who calls.** What is copied is what the caller can read, where it goes is where the caller can write (`FOR UPDATE` on the phase or the program; `FOR KEY SHARE` on the row of `students` for a new program — every row lock goes through the policies of `UPDATE`). A migration that changes who may write a draft, a block in the trash or an athlete's programs changes who gets through, and has nothing to rewrite here: since migration 20 the coach copies nothing into a draft — the first row of the copy is refused (`draft_read_only`), and nothing of it stays — and still copies a draft into a block of their own (`duplicate_program`).
- **An exercise that is not in the library of the destination's coach is left out and counted, never an error.** `trg_check_slot_exercise_in_coach_library` (migration 05) would refuse the slot, and the whole copy with it — for every block of an athlete who changed coach. The functions keep the slots whose exercise is in `exercise_library` under `students.coach_id` of the destination, and answer `slots_left_out`. A rule that makes more exercises unfit for a slot joins that `EXISTS`, or every copy that meets one fails.
- **The header is what the app calls, and the answer is an object.** `jsonb`, with the id of what was made under `session_id`, `session_ids`, `week_id` or `program_id`, the counts, and `slots_left_out`: keys are added, never renamed. The arguments with a default (`p_title_suffix`, `p_dest_program_id`, `p_label_suffix`, `p_target_student_id`, `p_name_suffix`) may be left out of a call; a new argument is added at the end with a default, and `CREATE OR REPLACE` cannot rename one or take a default away.
- **A copy takes its place under the lock of its parent, from the top down** — the phase then its sessions (`duplicate_session`, `copy_sessions`), the program then its phases (`duplicate_week`), the athlete's programs in the order of their ids (`duplicate_program`) — the order of migration 11. `duplicate_session` moves the sessions after the source down by one: parked above every number the phase holds, then placed.
- **A copy starts as a session nobody has trained, and a block nobody trains.** No `reviewed_at`, `performed_at` or `scheduled_date`; `archived_at` only where a whole phase or block is duplicated; a new program is `approved`, not active, out of the trash and the coach's (`created_by` NULL) whatever its source was. A new state a program or a session can be in is decided here too.

## A migration that writes a set for an athlete, or a device for an account

Since migration 13 two functions do for an account what its own rights do not fit: `public.ensure_set_logs(p_session_id)` adds the prescribed sets that are missing in a session of the caller, and `public.claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)` registers a device for the caller, taking it over from another account when the caller presents its keys. `supabase/tests/ensure-claim.test.js` holds them.

- **They are `SECURITY DEFINER`, so they hold the rules themselves.** The owner of the tables is not held by row-level security: each function asks who calls first (`auth.uid() IS NULL`, then a comparison that is `IS DISTINCT FROM`, never `<>`), and `ensure_set_logs` asks the three questions of an athlete's write (migration 08) through the helpers the policies of `set_logs` use — `student_profile_for_session`, `program_active_for_session`, `session_writable`. A migration that changes one of those rules changes these functions with it, and has nothing to rewrite here; one that adds a FOURTH question to the policies of `set_logs` adds it to `ensure_set_logs`.
- **`app.trusted_set_log_insert` is the mark of `ensure_set_logs`, and of nothing else.** It is `'on'` while the one `INSERT` of the function runs: that is how a trigger on `set_logs` tells a prescribed set the function adds from a set the athlete inserts by hand — `auth.uid()` is the athlete in both. No trigger reads it yet; the contract migration that turns an athlete's own `INSERT` into an extra set without targets will, as `coalesce(current_setting('app.trusted_set_log_insert', true), '') = 'on'`. Three things keep the word worth something:
  - no other function sets it, and nothing but that `INSERT` is written while it is on (the test reads the body);
  - it is switched `'off'` by hand before the function returns. A `set_config(…, true)` of ANOTHER setting inside a function that carries a `SET` clause is not taken back when the function returns: it lasts until the end of the transaction. (A call that fails takes it back with everything else.)
  - **never give `authenticated` a function that sets a setting whose name or value its caller chooses**, and never expose a schema that holds one: an API user runs no statement of their own, and that is the only reason they cannot say `'on'` themselves. Unlike `app.allow_history_delete`, this setting is honoured for a request that carries a user id — it has to be.
- **A new column of `set_logs` is listed in `WHAT_A_NEW_SET_IS`** at the top of that test as `written` or `left`, or the suite fails. A target the coach prescribes is written by `ensure_set_logs` from the exercise — next to `approve_program` and the copy functions, which write the same columns; what the athlete does with a set is left to its default. Re-create the function from `schema.sql` (`SET search_path`, `SECURITY DEFINER`, the `REVOKE`/`GRANT`, the two `set_config` lines around the `INSERT`), and keep its header: `p_session_id`, an `integer` for an answer.
- **The number of sets is read under a lock.** `ensure_set_logs` holds the exercises of the session `FOR SHARE`, in the order of their ids, while it reads `exercise_slots.sets` and inserts. Whatever changes the number of sets of an exercise writes the count FIRST, then reads the rows again and removes what is over or adds what is missing — as the editor does (`useUpdateSlot`, then `reconcileSetLogCount`). The rows first and the count after leaves a set the function has added in between above the count; rows added without reading again meet the ones the function has added on the unique key.
- **A set that is missing is added on its number, and a row that stands on that number is left alone** — an extra set of the athlete included (`ON CONFLICT DO NOTHING`, which is also what makes two calls at once harmless). Do not "repair" such an exercise by renumbering inside the function: the athlete's set may be logged.
- **One row per endpoint, and a row changes hands only with its keys.** `push_subscriptions.auth` is a secret the browser shares with this database: it is what proves that the caller holds the subscription whose row they take over. A policy or a function that lets an account write the row of another one without it lets anybody who has learnt an endpoint send their notifications to that device, and stop its owner's. For the same reason no policy lets an account READ another account's row.
- **A column added to `push_subscriptions` is the device's or the account's.** What describes the device (its keys, its user agent) moves with the row; what an account chose for itself (a preference, a mute) must be reset in the `'rehomed'` branch of `claim_push_subscription`, or the next account on a shared device inherits it.
- **The four policies of `push_subscriptions` and the athlete's `INSERT` policy on `set_logs` stay** while an app from before wave 2 is in use: it registers a device with its own upsert and adds the missing sets with its own `INSERT`. Closing either is a `contract` migration.
- **The refusals** are `not authorized` (`42501`: no user id, or — for `ensure_set_logs` — not the caller's own session; somebody else's session and no such session are the same answer) and four fixed words with `P0001`: `program_not_active`, `session_not_writable`, `subscription_incomplete`, `endpoint_keys_mismatch`. The answer of `claim_push_subscription` is an object (`subscription_id`, `outcome`: `created`, `refreshed` or `rehomed`): keys and outcomes are added, never renamed.

## A migration that creates a table, a view or a sequence

Since migration 14 a request without a session holds no privilege on any table, view or sequence of `public`; a signed-in user holds `SELECT`, `INSERT`, `UPDATE` and `DELETE` on every table — the four that row-level security judges row by row — and `USAGE` on a sequence; the service role and the owner hold everything; and what `postgres` creates in `public` starts with the same. `supabase/tests/table-acl.test.js` holds each of the rules below against the catalog, for every table there is.

1. **Row-level security in the same file, with the policies.** The four privileges are on a table from the moment it is created: until `ALTER TABLE public.t ENABLE ROW LEVEL SECURITY` has run, every signed-in account reads and writes every row of it. With row-level security and no policy, the table is the service role's alone — which is a fair way to start one that only an Edge Function writes.
2. **In the migration, the privileges stand next to the table**, so that the result does not depend on the default privileges of the database the file runs in:

   ```sql
   ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
   REVOKE ALL ON TABLE public.t FROM PUBLIC, anon, authenticated;
   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.t TO authenticated;
   ```

   All four, also when the policies cover fewer commands: a command without a policy is refused by row-level security (`rls` in the matrix, for an `INSERT`) or reaches no row (`0`). Nothing else — `TRUNCATE` is not subject to row-level security and fires no `DELETE` trigger, `MAINTAIN` locks a table against every reader, `TRIGGER` and `REFERENCES` are for whoever writes migrations.
3. **In `schema.sql`, the table is defined above the `TABLE PRIVILEGES` block at the end of the file, and carries no `GRANT` of its own.** That block takes back, for every table at once, what Supabase's default privileges gave: nothing below it creates a table, a view or a sequence of `public`. A table on which a signed-in user must hold less than the four says so at the end of that block, and in `LESS_FOR_USERS` of `table-acl.test.js` with the reason.
4. **Never `anon`, never `PUBLIC`.** Nothing of this app is served without a session, and a grant to `PUBLIC` is a grant to `anon`.
5. **A view is created `WITH (security_invoker = true)`.** Without it a view reads its tables with the rights of its owner, whom row-level security does not hold: it shows every row to whoever may read the view — and a signed-in user may read a new view, as it may read a new table. A materialized view and a foreign table have no row-level security at all: revoke everything from `authenticated` on one, and reach it through a function.
6. **A numbered column** works with what a signed-in user holds: `USAGE` on the sequence is the next number, for the default of a `serial` column; `GENERATED … AS IDENTITY` asks for nothing. Reading the counter and `setval()` are not given.
7. **Something that is not about rows is not done with the caller's rights.** A function that must empty or rebuild a table for a user is `SECURITY DEFINER`, asks who calls first (migration 02), and is listed in `function-acl.test.js`. A `SECURITY INVOKER` function that needs `TRUNCATE` fails for every signed-in user.
8. **The table gets its insert probe in `rls-matrix.test.js`**, and the snapshot is regenerated: the test fails on a table without one. Its `anon` column reads `denied` on every line.
9. **The table joins a list of `retention.test.js`**: `KEPT_FOR_GOOD` with the reason, or `DELETED_BY_A_RUN` with its age — and then its `DELETE` in `run_retention` ("A migration that deletes rows by their age", below). The test fails on a table that is in neither.

The default privileges of `supabase_admin`, the platform's own role, are untouched — `postgres` cannot change them: a table that role creates in `public` (line 15 of the audit of migration 14) starts open to everyone. Nothing of the app is created by it.

## A migration that tells somebody something: a bell row, a push, a device

Since migration 15 a push leaves the database through one function, `public.send_push_event(p_user, p_payload, p_options)`, and a device's endpoint is an address at a known push service. `supabase/tests/push-plumbing.test.js` holds it.

- **No function reads the vault or calls `net.http_post` itself.** `send_push_event` is the one that does: the address (`app_functions_url`, then `/send-push`), the bearer (`app_internal_bearer`, and `app_service_role_key` while the vault has none of that name), a time limit of 10 seconds. A copy of that block in another function is a push without the time limit, with a bearer read under one name only — the test refuses a second function whose text holds `net.http_` or `vault.`.
- **A function that notifies calls it inside a net of its own, and after its bell row:**

  ```sql
  INSERT INTO public.notifications (recipient_id, kind, payload) VALUES (…);

  BEGIN
    PERFORM public.send_push_event(
      v_recipient,
      jsonb_build_object('title', …, 'body', …, 'tag', …, 'data', jsonb_build_object('url', …))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (…) failed: %', SQLERRM;
  END;
  ```

  The write that caused the push is never undone for it: `send_push_event` raises for an argument that is not what it should be, and when pg_net or the vault is out of reach. The test reads the text of every caller for that shape — the call, then `EXCEPTION WHEN OTHERS`, then the warning, nothing in between — and the function joins `LATER_SENDERS` there with the sentence of its warning (`THE_ELEVEN` is the list of migration 15, and stays the eleven). Whatever the text of the push is put together from stands inside the same net.
- **A function that calls it is `SECURITY DEFINER`.** `send_push_event` is `SECURITY INVOKER` and executable by its owner and the service role only: it has no right of its own. Called from a function that runs with the rights of a signed-in user it is refused — and the net turns the refusal into a warning: no push, and nothing on the screen says why. Do not "fix" that with a `GRANT` to `authenticated`, nor by making `send_push_event` `SECURITY DEFINER`: whoever may call it sends any text and any link to any account.
- **What is handed over** is `{ "user_id", "payload", "ttl": 86400 }` plus the keys of `p_options`, at the top level of the body. The payload is what the service worker shows (`title`, `body`, `tag`, `data.url`) and goes through as it is; `ttl` is how many seconds the push service keeps the message for a device that is offline, and a caller that wants another one passes it. An option `send-push` does not know is ignored by it: a new option is taught to the function first, then passed here.
- **Nobody reads the answer.** pg_net sends the request once the transaction has committed, and tries once. A function cannot know whether a push arrived, and nothing may depend on it: the bell row is the record.
- **`CREATE OR REPLACE` of one of the eleven** copies the function from `schema.sql`, and keeps the sentence of its warning (the log is searched for it), the `tag` of its push (it is what makes two pushes one line on a lock screen) and, for the five RPCs, the line that asks who calls (migration 02).
- **The list of push services is one list in four places**: the constraint `push_subscriptions_endpoint_known_push_service` in `schema.sql`, the migration that last wrote it (the rule, and the count that decides whether it is validated), `supabase/functions/_shared/pushHosts.js`, which the Edge Functions ask before they send, and `supabase/tests/fixtures/push-endpoints.json`, which both sides are held to. A push service is added in all four, in one commit: here by a migration that drops the constraint and adds it again, the way migration 15 added it. The pattern has no backslash and none of ``" $ ` !``, so that it reads the same in SQL and inside a shell's double quotes — keep it that way, the runbook page pastes it.
- **A rule on what a row may hold, added to a table that holds rows, is added `NOT VALID` and validated in the same transaction when no row breaks it.** `NOT VALID` judges every `INSERT` and every `UPDATE` from then on — an `UPDATE` that leaves the column alone included, so a row in the way can be deleted and no longer changed — and reads none of the rows that are there. The audit counts the rows in the way with the pattern of the rule; the page lists them, says what each kind means and gives the statement that validates afterwards. The migration deletes none of them. Validated by the migration when it can be, the rule reads the same in production and in `schema.sql`, which declares it validated.
- **A migration never writes a secret, and an audit never prints one.** The vault is the owner's (`docs/runbook/30-edge-functions.md`): a migration that needs a secret under another name reads both, as `send_push_event` does. An audit says whether a secret is there and whether two of them hold the same value — compared, never shown — and lists a device by the host of its endpoint, never by the endpoint, which is a secret of that device.
- **A rollback that puts back functions which read a secret under its old name refuses to run while only the new name is there** (the guard of `2026_10_13_15_push_plumbing.down.sql`): it would be every push stopped, and no error anywhere.

## A migration that schedules, sends or takes back a rest push

Since migration 16 the end of a rest is a row of `public.scheduled_pushes` that four functions write, and that is sent once. `supabase/tests/rest-push.test.js` holds it.

| Function | Who calls it | What it does |
|---|---|---|
| `schedule_rest_push(p_seconds, p_payload, p_endpoint)` | the app, at the start of a rest | the row, due at `now() + p_seconds` on the server's clock; closes what the caller still had waiting; deletes the caller's rows older than 7 days; answers `{ id, fire_at, mode }` |
| `cancel_rest_push(p_id)` | the app, when the rest ends early | closes a waiting row of the caller; answers `{ canceled }` |
| `claim_rest_push(p_id)` | whoever sends — the Edge Functions, with the service-role key | `pending` to `sending`, once; answers the row, or NULL |
| `dispatch_due_rest_pushes()` | the pg_cron job `sl-rest-push`, where there is one | closes the rows more than a minute late; hands each row due within ten seconds to `send_push_event`, once |

- **One claim, and it is the only way a row gets sent.** A sender — a function, a job, anything a later migration adds — asks `claim_rest_push(id)` at the time of the push and sends only what it is answered. It never sends a row it merely read, and it never writes `sending` itself. Two ways to send exist on purpose (the job and the Edge Function, and an app from before wave 3 calls the Edge Function whatever the mode): the claim is what makes one notification of them. `rest-push.test.js` has the test on two connections ("two senders take one row in the same instant").
- **The job hands a row over; it does not take it.** `dispatch_due_rest_pushes` marks `dispatched_at` and leaves the row `pending`: `send-push` waits until `not_before` and claims then. A row moved to `sending` ten seconds ahead could not be claimed by the function that sends it, and a rest that ends early in those ten seconds could no longer be taken back.
- **Handed over once, and never again.** The mark is what keeps a row from going to `send-push` every ten seconds — which a `send-push` that does not know `schedule_id` would answer by ringing every time. A retry of a lost request does not belong in the job for the same reason.
- **A row is canceled when its status says so OR `canceled_at` is set.** The app from before wave 3 cancels by writing `canceled_at` on a row it leaves `pending`. Whatever reads "is this row still to be sent" asks both: `status = 'pending' AND canceled_at IS NULL`.
- **More than a minute late is never sent.** The limit is written as `interval '60 seconds'` in the three functions that judge it and in the statement of migration 16 that closed the backlog: a migration that changes it changes all of them, and the test of each.
- **`mode` is `'cron'` only while `cron.job` holds an active job named `sl-rest-push`** — that name is the contract with the migration that makes the job. No pg_cron, no job, a job switched off, a table that cannot be read: `'edge'`, which costs one call of the Edge Function and never a second push. The lookup stands in an `EXCEPTION` block: a rest is scheduled whatever becomes of that question.
- **An account names a device of its own.** `scheduled_pushes.endpoint` says where a push goes, so it is one of the caller's `push_subscriptions` or NULL (every device): `schedule_rest_push` refuses anything else (`device_not_registered`), and the `INSERT` and `UPDATE` policies of the table ask the same of a row an account writes itself. A sender reads the devices of the row's `user_id`, filtered by the endpoint — never the endpoint alone. A new column that says where, to whom or what a push is gets the same question on both paths.
- **`claim_rest_push` and `dispatch_due_rest_pushes` are not for a signed-in user** (`NOT_FOR_USERS` of `function-acl.test.js`). The claim is `SECURITY INVOKER`: it has no right of its own. The dispatcher calls `send_push_event`, so it is `SECURITY DEFINER`, keeps the call in a net of its own, and is listed in `LATER_SENDERS` of `push-plumbing.test.js`; `rpc-auth.test.js` lists it as the one `SECURITY DEFINER` function that is for no client.
- **`schedule_rest_push` and `cancel_rest_push` are `SECURITY DEFINER` and ask who calls first** (`rpc-auth.test.js`). They must go on working once a `contract` migration has dropped the two policies through which an account writes the table itself; that migration drops the policies and nothing else.
- **The header is what the app calls.** `p_seconds`, `p_payload`, `p_endpoint` (which may be left out), `p_id`; `jsonb` answers whose keys are added, never renamed. The refusals are `not authorized` (`42501`) and three fixed words with `P0001`: `rest_seconds_out_of_range`, `payload_invalid`, `device_not_registered`. A cancel that comes too late is not a refusal.
- **The statuses are six, and a seventh is a migration.** `scheduled_pushes_status_check` is replaced the way migration 16 replaced it: guarded by the definition it expects, in one `ALTER TABLE`. A rollback that puts an older rule back says what it makes of the rows that rule cannot hold — it does not make them `pending`.
- **A migration that closes or deletes rest pushes leaves the ones that are running alone**: a row whose time is still to come, or less than a minute past, belongs to a sender that is waiting for it.

## A migration that changes when an athlete may write in a block, or switches one off

Since migration 17 a block stays open for its athlete for 72 hours after it is switched off, so that training logged without a connection is saved when the coach has activated the next block in between: `programs.deactivated_at` says when a block was switched off, the trigger `trg_stamp_program_deactivated_at` writes it, and `public.program_active_for_session(session)` — the second of the three questions of an athlete's write — answers yes for a program out of the trash that is the active one or was switched off less than 72 hours ago. `supabase/tests/replay-grace.test.js` holds it.

- **"Open for its athlete" is `program_active_for_session` / `program_active_for_slot`; "the block being trained" is `programs.is_active`.** They were one thing until migration 17, and the names of the functions still say so. A rule about what an athlete may WRITE asks the function, and gets the window with it. A rule about which block is the current one — what a list shows as to do, what a notification calls the athlete's block, a count "of the active block" — reads `is_active`, never the function: for three days after a switch two blocks of one athlete answer yes to it.
- **The 72 hours are one number in one function.** `interval '72 hours'` is written in `program_active_for_session` and nowhere else in the database; the test counts. Whatever needs "may the athlete still write here" calls the function. A policy or a function that compares `deactivated_at` itself is a second number to keep in step — and a second place that forgets the trash.
- **`CREATE OR REPLACE` of `program_active_for_session` keeps four things.** `p.deleted_at IS NULL` in front of everything: a block in the trash is closed, window or not. `p.status = 'approved'` on the window: a draft is never trained in. An answer that is `true` or `false` for a session that exists — `p.deactivated_at IS NOT NULL AND …`, or the comparison answers NULL for every block that has no time, and a caller that compares with `false` is wrong from then on; NULL stays the answer for a session that does not exist. And its header: `STABLE`, `SECURITY DEFINER`, `SET search_path`, executable by `authenticated` — the policies call it with the rights of the athlete, and one missing grant refuses every write of every athlete.
- **Whatever switches a block off is caught by the trigger, not written into the function that does it.** `trg_stamp_program_deactivated_at` fires before every `INSERT` and `UPDATE` of `programs`: `now()` when `is_active` goes from true to false, NULL while the row is active. The two `UPDATE`s of the app from before wave 2, `activate_program`, a block that goes to the trash while it is active: each is that one transition on the row. A new function that switches a block off writes `is_active = false` and nothing more.
- **`deactivated_at` is not written by a request that carries a user id** — silently, like the pins of migration 06: the statement is accepted, the rest of it is saved, the column keeps its value, and a new row starts without one. It has to be so: the author of a draft writes the row of their draft, and a time put there — one far ahead — would keep the block open for its athlete once the coach has approved it. A `SECURITY DEFINER` function called by a user is still that user. A function that must open or close a window for somebody is therefore for the service role or the owner (`NOT_FOR_USERS` of `function-acl.test.js`), and a test about the column reads the row back.
- **Without a user id the column is written as the statement says — on a block that is not active, and not in the statement that switches it.** That is how the owner closes a window early (`NULL`) or opens one again (`now()`): `docs/runbook/migrations/17-replay-grace-window.md`. The switch itself always stamps `now()`, and an active block never holds a time: a migration that must switch a block off AND give it another time does so in two statements.
- **A block that was never active has no time, and neither has a copy.** `deactivated_at` is in `left` of `WHAT_A_COPY_IS` (`copy-rpcs.test.js`): a function that makes a program does not name the column. Rows from before migration 17 have none either — nothing said when they were switched off — and a later migration does not invent one.
- **The trigger fires after `trg_pin_program_authoring_columns`, because of its name**, and neither reads a column the other writes. A trigger on `programs` that changes `is_active` itself must come before it by name, or the time is not written.
- **In a test, a past block is `pastBlock(q, program)`** of `supabase/tests/harness.js`: `update programs set is_active = false` alone is a block inside its 72 hours, which its athlete still writes. A block created with `active: false` never was the active one and is closed from the start. Inside a `scenario()` the clock is one instant: a block switched off there was switched off exactly now.
- **A rollback of such a rule closes every open window at once**, and says so first thing in its header: what is waiting on a phone for a block that was switched off is refused when it arrives.

## A migration that deletes rows by their age

Since migration 18 the rows nobody reads any more are deleted by one function, `public.run_retention()`, which the owner runs once a month (`docs/runbook/70-admin-procedures.md`) — or a pg_cron job every night, where the optional migration 19 is applied. It answers `{ "scheduled_pushes": n, "notifications": n, "client_errors": n }`, the rows that run deleted. `supabase/tests/retention.test.js` holds it.

| Table | A row goes | Never |
|---|---|---|
| `scheduled_pushes` | 7 days after it was written | one that is still to be sent |
| `notifications` | 90 days after its recipient read it | one that was not read |
| `client_errors` | 90 days after it was reported | — |

- **Every table of `public` is in one of two lists of `retention.test.js`**: `DELETED_BY_A_RUN`, with its age, or `KEPT_FOR_GOOD`, with the reason. A migration that creates a table adds it to one of them, and the test fails until it does. A table that fills by itself — one row per event, of no use after a while — is the first kind. A table of training is never: what an athlete logged is kept for good, and nothing deletes it by its age.
- **A table of the first kind gets its `DELETE` in `run_retention`, and nowhere else.** `CREATE OR REPLACE`, the function copied from `schema.sql`: the three `DELETE`s that are there, the new one in the same shape, and one more key in the answer — keys are added, never renamed: a job or a person reads them. Its `SECURITY INVOKER`, its `SET search_path` and its place in `NOT_FOR_USERS` of `function-acl.test.js` stay. Not a trigger that deletes on every insert, and not a second function with a job of its own: one place says what is deleted and when, and one audit counts it.
- **Each `DELETE` takes its rows through `FOR UPDATE SKIP LOCKED`.** A row another request holds at that instant is passed over and goes with the next run: a run never waits for the app, and never deadlocks with it. The test holds a row open on a second connection and counts the three clauses.
- **A migration does not run it.** Applying a file deletes no row for its age: the first run is the owner's, after the backup, with the audit of migration 18 read before and after — it counts what a run deletes with the conditions of the function, so a change of one is a change of both, and of the test.
- **An age is counted from the moment a row stopped being of use, not from when it was written, where the two differ.** A notification goes 90 days after it was READ: one that was never read is still on its account's bell, however old. A new table says which column that moment is.
- **"Still to be sent" is `status = 'pending' AND canceled_at IS NULL AND fire_at > now() - interval '60 seconds'`** — what `claim_rest_push` would still hand to a sender ("A migration that schedules, sends or takes back a rest push", above). The 7 days are written twice, here and in `schedule_rest_push`, which deletes the caller's own rows when they next rest; the test holds the two to the same rows.
- **It is `SECURITY INVOKER`, and for no client.** The owner and the service role hold every row. Given to `authenticated` by mistake it would delete what that user's policies let them delete — their own rest pushes — and nothing else; it is not given.
- **Nothing calls it.** No trigger, no other function: a run happens when the owner or the job says so, and the test refuses a function of `public` whose text names it. Without a run nothing breaks — the rows wait.
- **The rollback of such a migration does not bring back what a run deleted**, and says so in its header: those rows are in the backup taken before that run, and nowhere else.

## A migration that needs an extension the project may not have

Since migration 19 a migration can wait for an extension that a Supabase project does not have until its owner switches it on: pg_cron. Production does not have it, and may never. Such a migration is a choice, and everything about it is written so that **not making it is the usual case**. `supabase/tests/cron-jobs.test.js` holds it; `supabase/tests/parity.test.js` compares both kinds of project.

- **It is `optional`, and says which extension in the manifest**: `"extension": "pg_cron"`. No later migration may need it — not by its guard, not by what it uses — and no client may: whatever it does has a way that works without it, which its runbook page describes first.
- **Its guard asks for the extension after the ledger, and refuses with `SLM06`** (`REFUSAL.extensionMissing`): `needs the extension pg_cron, which is not switched on in this project`, with a hint that says the migration is optional and what the project does without it. Nothing is touched. It never runs `CREATE EXTENSION` itself: switching an extension on is the owner's decision, taken in the dashboard.
- **It asks for what it uses, by name, before it uses it.** The schema of an extension, its tables and its functions are the platform's, and what `postgres` may do with them is the platform's to decide: the guard asks `to_regnamespace` and `has_schema_privilege` first — `to_regclass` of a table in a schema one may not use is an error, not an answer — then `has_table_privilege` and `has_function_privilege` for each object, and the columns its functions are written with. A refusal that names the object is worth more than a job that fails at night.
- **In `schema.sql` everything it makes stands inside ONE block that asks for the extension first, and does nothing without it** — a function included, created there with `EXECUTE`. The line of the ledger is a statement of its own, under the same condition. So a database installed without the extension is, to the last object, production without the migration; and one installed with it is production with it. Nothing of such a migration is written outside its block: the test reads the file.
- **Two projects, both compared.** `parity.test.js` builds the baseline plus the migrations twice — as production is, without the migrations that name an extension, against the database every test file is cloned from; and with each extension switched on right before the first migration that needs it, against `schema.sql` loaded into a project that has them. A table the migration fills (`cron.job`) is in `REFERENCE_DATA` of `supabase/tests/catalog.js`, with the columns that do not depend on the database.
- **The database the suite runs on does not have the extension.** `asUser()` and the other helpers run on production as it is. A test about a project that has it builds one: `scratchDatabase()`, then `db.enableExtension('pg_cron')` — the stub `supabase/tests/shim-pg-cron.sql`, run as the platform, the way the dashboard's switch does — then `schema.sql`, or the baseline and the migrations. A new extension gets its stub there, its name in `EXTENSIONS` (`manifest.js`) and in `EXTENSION_STUBS` (`harness.js`); the stub says what it leaves out, and is at least as strict as the platform about what `postgres` may do.
- **A test that builds "production before migration N" on the baseline runs `migrationsBefore(manifest.migrations, name)`** (`manifest.js`), which leaves out the migrations that wait for an extension the project does not have. A loop over the whole manifest stops at migration 19 with `SLM06`.
- **Its rollback is never refused for a later migration** — no `SLM04`: nothing may need what it removes, and the rollback is the way out of a choice. It works where the extension was switched off before it was run, when what the extension held is gone already: it removes what is left and the line of the ledger, so that the migration can be applied again.
- **Its audit runs in a project without the extension**, and says `not installed` instead of failing. A query that names a table of the extension does not even start where the schema is not there: the audit reads such a table through `query_to_xml`, which takes its query as text, and hands it one that reads nothing when the table is not there to read (the audit of migration 19).

## A migration that adds a job, or changes what one runs

Since migration 19 four jobs of pg_cron run where the extension is switched on: `sl-rest-push` (every 10 seconds, `dispatch_due_rest_pushes()`), `sl-retention` (every night, `run_retention()`), `sl-push-failures` (every hour, `record_push_failures()`) and `sl-cron-history` (every night, three days of pg_cron's own runs). `supabase/tests/cron-jobs.test.js` holds them.

- **A job is made, changed and removed through pg_cron's functions**: `cron.schedule(name, schedule, command)`, `cron.alter_job`, `cron.unschedule(name)`. `postgres` reads `cron.job` and may not write it: a migration or a rollback that says `DELETE FROM cron.job` fails in production — and in the stub, which is why the stub refuses it.
- **A job has a name that starts with `sl-`, runs as `postgres` in this database, and its command is one statement that calls a function** — or, for pg_cron's own table, one statement. What a job does is in a function of `public`, with its tests and its privileges, not in the text of a row.
- **The definition of a job is one text in five places**: the migration that makes it, the block of `schema.sql`, the `meant` list of the audit of migration 19, the names in its rollback, and `JOBS` in `cron-jobs.test.js` — plus the tables of the two runbook pages. The test compares them. A migration that adds a job or changes one calls `cron.schedule` under the guard of migration 19 (the extension, its version, what it may use), reads the job back — once, switched on, of `postgres`, in this database — and changes all of them.
- **`cron.schedule` on a name that exists changes the schedule and the command of that job, and leaves it switched off if it was.** That is why migration 19 refuses to run next to a job of one of its names; a migration that changes a job of the ledger switches it on with `cron.alter_job(jobid, active := true)` on purpose, or says why not.
- **The name `sl-rest-push` is a contract with `schedule_rest_push`**, which answers `mode: cron` while a job of that name is there and switched on — whoever made it, whatever it runs. Never give that name to another job. And **`send-push` must know what that job hands it** (`schedule_id`, `not_before`) before the job exists: the one from before wave 2 would ring at once, ten seconds early.
- **A job whose function writes a line somebody reads says so with the role `database`.** `record_push_failures()` writes into `client_errors` with `user_id` NULL and `role = 'database'`: no signed-in user can write such a row (the `INSERT` policy holds a report to the account and the role of its author), and a policy that narrows who reads `client_errors` keeps those lines readable by a coach. Its `url` is the key that keeps an hour from being written twice (`pg_net 2026-10-13T14:00Z`): a new kind of line from the database takes another prefix.
- **A request failed when it was not answered with a status from 200 to 299** — the condition is written in `record_push_failures()`, in line 17 of the audit of migration 19 and in the statement of `docs/runbook/50-pg-cron.md` that lists the failed answers; the test holds the three to the same rows. `send-push` therefore answers 2xx for everything that is not a failure — an account without a device included — or the coach's list fills with lines that mean nothing.
- **pg_cron keeps one row per run and deletes none**: a job that runs often is a table that grows. `sl-cron-history` keeps three days, by the number of a run and not by its time — a run that never started has no time. A new job that runs every few seconds needs nothing more; one whose runs must be kept longer changes that statement, in the five places.
- **What a job deletes is deleted without anybody asking.** The page of a migration that makes a job run a function that deletes rows says what the first run deletes, and that the backup taken before the file is the one that holds it.

## A migration that touches who writes the tree of a draft

Since migration 20 the phases, sessions, exercises and sets of a draft are written by its author alone: the trigger `block_draft_tree_write` — one name on `weeks`, `sessions`, `exercise_slots` and `set_logs`, one function per table — refuses a write that carries a user id other than `programs.created_by` on a row of a program whose status is `draft`, in the trash or not. And `approve_program` marks the program approved first, then writes. `supabase/tests/drafts-readonly.test.js` holds it.

- **The row of the program is not judged.** Approving, sending back, renaming, the trash and a delete are writes of `programs`, which has no such trigger: they stay the coach's. A rule that closed that row to the coach would close `approve_program` and `send_back_program` with it.
- **"Not the author", not "the coach".** Row-level security already keeps every other account away from a draft; asked of the author, the rule also holds for a program made a draft by hand, whose author is empty: nobody who signs in writes its tree until it is approved. A new table that hangs under the tree and that a coach may write gets the same trigger, with its own lookup up to the program — or the coach writes it into a draft. (The four an athlete writes under a session — `slot_comments`, `slot_deviations`, `set_log_videos`, `session_confirmations` — need none: their policies ask for the block being trained, which a draft never is.)
- **An `UPDATE` is judged on its parent as it was AND as it would be**: nothing moves into a draft, nothing out of one. A trigger that read `NEW` alone would let a session of a draft be moved out into a block of the coach.
- **A request without a user id goes through, and reads nothing first**: the SQL editor, a migration (migration 21 clears `day_number` as the owner), the service role. With a user id, ONE lookup by primary keys up to the program — on `set_logs` that is every tap of an athlete: keep it one lookup.
- **A missing parent is "not a draft".** During a cascade — the coach deletes a draft, the author discards one, `save_draft_tree` deletes the phases — the parent row is already gone, the lookup finds nothing and the row goes. That is how the coach still deletes a draft with what is under it. (The delete guards of migration 04 rely on the same thing: `block_set_log_delete_when_logged`.)
- **The name sorts first.** `block_draft_tree_write` comes before every other `BEFORE` trigger of the four tables (`block_s…`, `block_w…`, `trg_…`): on a draft the refusal is the answer before any guard or pin is asked. A new `BEFORE` trigger on one of these tables that must run before it is named accordingly — and a rename is a change of behaviour (`review-lifecycle.test.js` lists the order on `sessions`).
- **`STABLE`**, like `pin_draft_session_columns` and the helpers of the author's policies (`program_is_own_draft`): it judges the program as the statement saw it when it started, as the policies do. `SECURITY DEFINER`: it reads the program whatever the caller may read.
- **An `INSERT` is judged by its triggers before row-level security checks the row.** A stranger's insert into a draft — another athlete, another coach — is answered `draft_read_only`, not with the message of row-level security (`P0001` in their columns of `snapshots/rls-matrix.txt`). Refused either way, and an `UPDATE` or a `DELETE` of a stranger still reaches no row.
- **A function the coach calls is the coach.** A `SECURITY DEFINER` function that writes into the tree with the coach's user id is refused on a draft like a request of theirs; the copies of migrations 11 and 12 are refused at their first row. A function that must write a draft for its coach marks it approved first — as `approve_program` does.
- **`approve_program` marks the program approved FIRST, under the lock of its row**, with `WHERE … AND status = 'draft'` and `IF NOT FOUND THEN` the answer for a program that is not a draft: an approval that crossed it answers `{ approved: false }`, and a save of the author that arrives meanwhile waits for the row, then is refused. A `CREATE OR REPLACE` keeps that order: written the other way round, its own sets are refused (`draft_read_only`), and the check of `docs/runbook/migrations/20-drafts-coach-readonly.md` answers `BROKEN`. Its answer — `approved`, `set_logs_created` — and its push are unchanged.
- **A set without a target is written again by the approval**: not added by the athlete, no `target_reps` and no `target_duration_seconds`, not logged (`set_log_is_logged`), no video. The condition is written in `approve_program`, in line 14 of the audit of migration 20 and in the list of drafts of its runbook page: a change of one is a change of the three, and of the test. A set with a target is kept.
- **The refusal** is `P0001` with the word `draft_read_only`, the sentences in `DETAIL` and `HINT` (what the table is, the program, and to approve or send back). The app deployed before the client half of P53 shows it as `errors.generic`; the word is what a client maps.

## A migration that touches an RPE or the weekday of a session

Since migration 21 `set_logs.rpe` is `numeric(3,1)` and `sessions.day_number` is a weekday or nothing. `supabase/tests/small-hardening.test.js` holds both.

- **An RPE is 1 to 10 in steps of 0.5**: `set_logs_rpe_check` and `set_logs_rpe_half_step`, next to `set_logs_no_rpe_when_failed`. A function that reads or writes one declares it `numeric`, never `integer`: an assignment to an integer rounds 7.5 to 8 without a word. A text built from one prints `8.0` — `trim_scale(rpe)` prints `8`.
- **A weekday is 1 to 7, or NULL** (`sessions_day_number_weekday`). A function that writes one from what a client sends — a whole tree in one statement — writes a number outside 1 to 7 as NULL, as `save_draft_tree` does: one stale value from a phone's cache would otherwise refuse everything else the request carries. The coach's editor writes 1 to 7 or NULL; the copy functions copy the value as it is.
- **A weekday is advice, and a migration that clears some says which.** Its header and its audit count them, and its page lists them before it runs: they do not come back with a rollback (page 21, "The sessions that lose their weekday").
- **Changing the type of a column of `set_logs` writes the whole table again** under `ACCESS EXCLUSIVE`; a dump that is reading it at that moment makes it wait (`backup-roundtrip.test.js`). Lock the tables of the tree first, from the top down — `LOCK TABLE public.sessions, public.set_logs IN ACCESS EXCLUSIVE MODE` — and drop and add again a `CHECK` on the column rather than let `ALTER TYPE` carry it over: the text it is parsed into again is not the text of `schema.sql`. The rollback rounds what the old type cannot hold, and its header says how.
- **A choice the owner makes when applying a file is a setting of the session, read by the file**: `app.day_number_clearing` in migration 21, which its guard refuses when it is neither `all` nor `drafts`. The page gives the command that sets it (`set …; $(cat <file>)`); the file run alone does what the plan decided.

## A migration that touches who reads a client error, or how many an account reports

Since migration 22 a line of `client_errors` is read by its author and the coach of its author, a line without an author by every coach, and an account keeps 30 lines an hour. `supabase/tests/small-hardening.test.js` holds it.

- **A line without a `user_id` is read by every coach**: the database's (`role = 'database'`, `record_push_failures()` of migration 19) and those of an account that was deleted (`ON DELETE SET NULL`). A policy that narrows who reads the table keeps that branch.
- **"The coach of the author" is `students.coach_id`, today** — the rule of migration 10: a line of a former athlete is read by its author only. "Is a coach" is asked of `profiles` in the policy itself, not with `is_coach()`: a `SELECT` goes through it.
- **`trg_cap_client_errors` judges a request that carries a user id, and nothing else.** The owner, the service role, a job and a restore write as many lines as they need, with the date they give. A `SECURITY DEFINER` function called by a user is that user: its lines are counted and dated.
- **The cap drops, it does not refuse** (`RETURN NULL`): the request answers as if the line was kept, and nothing is written. A test about it reads the rows back. It counts by `auth.uid()` — the `INSERT` policy holds `user_id` to it — and dates the line itself (`created_at := now()`): a date the client sends would escape both the hour and `run_retention()`.
- **Nothing is deleted there.** A line goes 90 days after it was reported, through `run_retention()` ("A migration that deletes rows by their age", above).

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

Same transaction rules. Raise `SLM04` when a later migration still needs what the rollback would remove — except in the rollback of a migration that names an `extension`, which nothing may need.

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

A migration that names an `extension` is run in order like the others: the test switches the extension on right before it — a stub, `supabase/tests/shim-pg-cron.sql` — and it stays on for the migrations after it.

Then, on a second copy of the baseline, it applies every migration that is not `optional`, in order: each must go through without the optional ones before it. And on a third, without the extension, each migration that names one must refuse with `SLM06` and change nothing.

"The catalog" is everything `supabase/tests/catalog.js` reads: tables, columns, constraints, indexes, triggers, policies, functions with their settings and privileges, types, default privileges, publications, comments, and the rows SQL files insert. A migration that seeds a table adds it to `REFERENCE_DATA` there, with the columns to compare; the parity test refuses rows in a table that is not listed, because all it could compare is how many there are.

A migration that changes what a role can do also changes `supabase/tests/snapshots/rls-matrix.txt`. Regenerate it (the command is in the file) and commit the diff with the migration: each changed cell is the change, in one line.

## Applying to production

Never from here. The user applies the files by hand: `docs/runbook/00-before-you-start.md`.
