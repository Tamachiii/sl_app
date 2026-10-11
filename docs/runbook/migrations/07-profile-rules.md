# 07 — A new account has a name, and you can make a coach

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_11_07_profile_rules.sql` |
| Audit | `supabase/audits/2026_10_11_07_profile_rules.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_11_07_profile_rules.down.sql` |
| Kind | required · replaces 2 function bodies; no table, no column, no policy, no new function, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P20, B10 |
| Needs | migration 06 |

Safe with the app that is deployed today: nobody who has an account sees a difference. Two things change for **you**: the next account you create has a name, and the statement that makes a coach works — [Making a coach](#making-a-coach).

## What it does

Every account has a *profile*: its name and its role, coach or athlete. Two rules about it were wrong.

- **The name of a new account was empty.** *Add user* in the dashboard asks for an e-mail address and a password, nothing else, and the profile was created with an empty name. The app shows a placeholder for it; the pushes to the coach do not, and read *" completed Session 3"* — with several athletes, the coach cannot tell whose session it was (B10).
- **Nobody could make a coach.** A new account is always an athlete, and a coach is made by you with one statement, `update public.profiles set role = 'coach' …`. The protection that keeps a signed-in user from giving themselves that role also applied to you: the statement answered `UPDATE 1` and changed nothing. A second coach could not be made, and a coach who lost their account could not get the role back on a new one (P20).

The migration replaces the two functions behind those rules:

1. **A new account always has a name**: the one it was created with, if it was given one (an invitation, later); otherwise the part of its e-mail address before the `@`; otherwise `Athlete`. Its owner changes it in the app, in Profile.
2. **The role of a profile is yours to change, and nobody else's.** A signed-in user — in the app or through the API — still cannot change a role, their own or anybody's. A statement run from the SQL editor, with `supabase db query`, or with the service-role key, can.
3. **A role change never contradicts who coaches whom.** An account that is somebody's athlete is not made a coach, and a coach who has athletes does not stop being one: the statement is refused with a sentence that says why. This is the rule of [migration 05](05-students-role-gate.md) — a link joins a coach to an athlete — seen from the other side.

## What the deployed client does differently

**Nothing, for an account that exists.** No profile is rewritten: a name that is empty today stays empty until somebody types one ([Accounts without a name](#accounts-without-a-name)).

**An account you create from now on** is shown under the first part of its address — `lea.martin` for `lea.martin@example.com` — where the app showed a placeholder: in its own Profile, on the coach's roster, in the notifications and the pushes to the coach. The athlete changes it in Profile, by tapping the name. That first part of the address is then visible to the coach — and, for a coach's account, to their athletes: if it should not be, give the account a name right after creating it (the second statement of [Accounts without a name](#accounts-without-a-name)).

**For somebody who calls the API by hand:** a role sent with one's own profile is accepted and not kept, as before. There is no error message.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_11_07_profile_rules.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | a new account gets its profile | `in place` | `in place` |
| 3 | a new account created without a name is given one (B10) | `no` | `yes` |
| 4 | a signed-in user cannot change the role of a profile | `in place` | `in place` |
| 5 | the owner of the database can change it (P20) | `no` | `yes` |
| 6 | a role that a coach-athlete link stands against is refused | `no` | `yes` |
| 7 | functions of this migration a request without a session may execute | `none` | `none` |
| 8 | functions of this migration a signed-in user may execute | `none` | `none` |
| 9 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 10 | profiles without a name | `0` | `0` |
| 11 | accounts | a sentence: *N coach(es), N athlete(s)* | the same |

Line 11 is information: the profiles there are, by role. It changes when you create an account or make a coach, not with the migration.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `missing` — stop and report. What gives a new account its profile was removed or switched off by hand: an account created today cannot use the app, with or without this migration. The migration refuses to run (`no trigger on auth.users calls public.handle_new_user()`).
- **3, 5 and 6 already read as in the "after" column** — the migration is in the database. Read the ledger (below): if migration 07 is there, you are done.
- **4** reads `missing` — go on, and report it. The protection of the role was dropped or switched off by hand, and until now any signed-in user could have made themselves a coach; the migration puts it back. Afterwards, read line 11: the number of coaches must be the number you made. [20, Auth settings](../20-auth-config.md) has the list of accounts with their roles.
- **7, 8 or 9** is not `none` — migration 03 is not applied, or was rolled back. Stop: apply it first.
- **10** is not `0` — go on. The migration changes none of those profiles; name them afterwards, with [Accounts without a name](#accounts-without-a-name).

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_07_profile_rules.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_11_06_pin_student_writes, which is not applied` (code `SLM02`) | migration 06 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `no trigger on auth.users calls public.handle_new_user()` | line 2 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …` or `did not get the triggers it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 3, 5 and 6 read as the "after" column; the others are unchanged. **Line 2 must still read `in place`.**

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: seven rows, the last one `2026_10_11_07_profile_rules`.

3. See it for yourself. This creates an account without a name, makes it a coach as you would, takes the role back, then signs in as that account and tries to make itself a coach — and then fails **whatever happened**, so that nothing is kept, the account included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_id uuid := gen_random_uuid();
     v_name text;
     v_role text;
     v_rows integer;
     v_owner text;
     v_user text;
   begin
     insert into auth.users (id, email, aud, role)
     values (v_id, $m$sl-check-07@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     select p.full_name into v_name from public.profiles p where p.id = v_id;
     if not found then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check got no profile$m$;
     end if;

     update public.profiles set role = $m$coach$m$ where id = v_id;
     select p.role into v_role from public.profiles p where p.id = v_id;
     v_owner := case when v_role = $m$coach$m$ then $m$yes$m$ else $m$NO$m$ end;
     update public.profiles set role = $m$student$m$ where id = v_id;

     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_id, $m$role$m$, $m$authenticated$m$)::text, true);
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     update public.profiles set role = $m$coach$m$ where id = v_id;
     get diagnostics v_rows = row_count;
     select p.role into v_role from public.profiles p where p.id = v_id;
     v_user := case when v_rows = 0 or v_role is null then $m$NOT TRIED$m$
                    when v_role = $m$coach$m$ then $m$YES$m$
                    else $m$no$m$ end;

     raise exception $m$check only, nothing was written: a new account without a name is called "%"; you can make it a coach: %; signed in, it can make itself one: %$m$,
       v_name, v_owner, v_user;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: a new account without a name is called "sl-check-07"; you can make it a coach: yes; signed in, it can make itself one: no`. Run before the migration, the same command fails with `… is called ""; you can make it a coach: NO; signed in, it can make itself one: no` — and writes nothing either.

   Anything else is **not** the answer:

   - `… signed in, it can make itself one: YES` — the protection of the role is not there. Roll back, and report.
   - `… signed in, it can make itself one: NOT TRIED`, or `… NOT TRIED: the account made for the check got no profile` — the check could not ask its question: a rule that is not in the database at this point of the sequence kept the account from being written or from writing its own profile. Stop and report it; until the check is corrected, lines 3 to 6 of the audit are what says whether the migration is in place.
   - a message that does not start with `check only` — the account for the check could not be created at all (the message says why). Nothing was written. Report it; the audit is what counts.

4. In the app that is deployed, signed in as the **test athlete** — and only once step 3 has answered as above: open Profile, tap the name, change it, save; then change it back. Both go through as before: every change of a profile passes through one of the two functions this migration replaced.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_11_07_profile_rules.down.sql
```

**It reopens the findings.** Run it only if, after the migration, creating an account fails — *Add user* in the dashboard answers `Database error saving new user` — or the app can no longer save a name in Profile. The database tests create accounts the way the dashboard and an invitation do, with and without a name, with and without an address, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

It gives the two functions back the text they had. No table and no row is touched, in either direction: the accounts that got a name keep it, and a profile you made a coach while the migration was in place stays a coach — after the rollback nobody can change that role any more, you included, until the migration is applied again.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Making a coach

From this migration on, this is how an account becomes a coach — the app has no screen for it, and a role sent through the API is not kept.

1. Create the account, if it does not exist: Dashboard → Authentication → Users → **Add user** ([20, Auth settings](../20-auth-config.md)). Every new account is an athlete.
2. Make it a coach, in Dashboard → SQL Editor, with its e-mail address:

```sql
update public.profiles p
   set role = 'coach'
  from auth.users u
 where u.id = p.id
   and u.email = '<e-mail of the account>'
returning u.email, p.full_name, p.role;
```

It returns one row, with `coach` under `role`. The account opens on the coach's side the next time the app is opened, with an empty roster and an empty exercise library. Its athletes are linked to it one by one: [05, Linking an athlete to a coach](05-students-role-gate.md#linking-an-athlete-to-a-coach).

| It answers | Meaning |
|---|---|
| no row | the address is not an account: check the spelling in Authentication → Users |
| one row, with `student` under `role` | the statement was accepted and changed nothing: migration 07 is not in the database, or was rolled back. Read the ledger (step 2 of [After](#after)) |
| `profile … cannot be made a coach: it is the athlete of a coach` | the account trains under a coach, and an account is a coach or an athlete, not both. Nothing was written. Create a second account for coaching, with another address |
| `permission denied for table users` | the SQL editor is not running as `postgres`: the role selector of the editor is set to a user of the app. Set it back to `postgres` and run the statement again |

**Taking the role back** is the same statement with `'student'` in place of `'coach'`. It is refused — `profile … cannot stop being a coach: it has N athlete(s)` — as long as the account has athletes: they go to another coach first, with the function migration 10 of this checkpoint brings. Do not delete their links to get it through.

Each coach has a roster, a library and messages of their own: a second coach sees none of the first one's athletes, and none of their exercises.

## Accounts without a name

Line 10 of the audit counts the profiles whose name is empty: accounts created before this migration, whose owner never typed one. The app shows a placeholder for them; a push to the coach about one of them starts with a blank. The migration does not name them: you do, or their owner does in the app (Profile, tap the name).

List them, in Dashboard → SQL Editor:

```sql
select u.email, p.role, p.created_at::date as since
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.full_name !~ '[^[:space:]]'
 order by u.email;
```

Name one, with the name you want it to have:

```sql
update public.profiles p
   set full_name = '<name>'
  from auth.users u
 where u.id = p.id
   and u.email = '<e-mail of the account>'
returning u.email, p.full_name;
```

Or name all of them at once, the way a new account is named — the part of the address before the `@`:

```sql
update public.profiles p
   set full_name = coalesce(nullif(regexp_replace(split_part(u.email, '@', 1), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), 'Athlete')
  from auth.users u
 where u.id = p.id
   and p.full_name !~ '[^[:space:]]'
returning u.email, p.full_name;
```

Each prints the accounts it named. Then run the audit again: line 10 reads `0`. A name is the account's own to change afterwards, in the app.
