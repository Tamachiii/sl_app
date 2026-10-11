# 03 — Function privileges: allow-list, closed defaults, pinned search_path

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_11_03_function_grants_lockdown.sql` |
| Audit | `supabase/audits/2026_10_11_03_function_grants_lockdown.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_11_03_function_grants_lockdown.down.sql` |
| Kind | required · changes privileges and one setting of 36 functions; no table, no row, no policy, no function body |
| Wave / checkpoint | 1 / A1 |
| Findings | B2, L21, L23 |
| Needs | migration 02 |

**Apply it alone, then check the app before anything else.** It is the migration with the widest reach of the review: every query of the app goes through a function it touches. That is why Checkpoint A1 holds this file and nothing else. If the list it grants were wrong, the app would stop reading — at once, for everyone — and the rollback puts the grants back in one command.

## What it does

Today every one of the 36 functions of `public` can be called through the API with nothing but the anon key, which is in the app's JavaScript. Supabase grants that by default to every function you create, and the repository never took it back. Twelve of them are the helpers the security policies are written with. They skip the policies by design, and they answer, for any id:

- which athlete a session, an exercise, a set or a goal belongs to, and who coaches them;
- whether two accounts are coach and athlete;
- whether a program is the active one.

Those ids are in the app's URLs and in every push notification. No training data can be read this way — only who is linked to whom.

The migration does four things:

1. **Takes every right on every function of `public` away** from `PUBLIC` (everyone), `anon` (a request without a session) and `authenticated` (a signed-in user).
2. **Gives a signed-in user back an explicit list of 19**: the 12 helpers the policies call, and the 7 functions the app calls (`adopt_swap`, `adopt_skip`, `decline_promote_request`, `approve_program`, `send_back_program`, `save_draft_tree`, `move_session`). The 17 trigger functions get nothing: a trigger runs whoever fires it. The service role (the Edge Functions) keeps everything.
3. **Closes what a new function starts with.** From now on a function created by `postgres` — by a migration, or by you in the SQL editor — can be called by nobody but `postgres` and the service role, until a `GRANT` says otherwise.
4. **Pins `search_path = public, pg_temp` on all 36.** 25 had none and looked names up wherever the caller said (L23); 11 had `public`. Every name in their bodies is already written with its schema, so nothing is looked up differently.

## What the deployed client does differently

**Signed in: nothing.** The app calls the same 7 functions and its queries go through the same 12 helpers, with the same answers.

**Without a session**, a request is now refused where it used to be answered:

- a call to any function of `public` fails with `permission denied for function …`;
- a query on `exercise_slots`, `goal_progress`, `messages` (sending), `session_confirmations`, `sessions`, `set_log_videos`, `set_logs`, `slot_comments`, `slot_deviations` or `weeks` fails the same way, where it used to return no row. The other tables still return no row.

The app does not send requests without a session. There is one way to get there with the app that is deployed today: a session that has expired and could not be renewed — the sign-in server did not answer, while the database did. The app then sends its requests with the anon key. Before this migration they came back empty (a screen saying there is no program) or did nothing; now the ten tables above answer with an error, and the app shows *You don't have permission to do that.* Signing in again ends it.

One case in that situation is worse than before, and only for an athlete who is writing a draft program at that moment. The deployed app reads "permission denied" on a draft save as "the coach has taken this draft over", and reloads the draft from the server: the edits that were not saved yet are replaced by the server's copy. Before the migration the app said *Couldn't sync your draft — it's saved on this device* and kept them. It takes an expired session that cannot be renewed and a draft being edited at the same time. The client of wave 2 no longer sends a write without a session.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_11_03_function_grants_lockdown.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | functions in public | `36` | `36` |
| 3 | functions the migration does not know | `none` | `none` |
| 4 | functions the migration expects and does not find | `none` | `none` |
| 5 | functions not owned by postgres | `none` | `none` |
| 6 | functions anon may execute (B2, L21) | `all 36` | `none` |
| 7 | allow-listed functions a signed-in user may NOT execute | `none` | `none` |
| 8 | other functions a signed-in user may execute | `all 17` | `none` |
| 9 | functions PUBLIC may execute | `30 of 36` | `none` |
| 10 | functions service_role may NOT execute | `none` | `none` |
| 11 | functions without a search_path (L23) | `25 of 36` | `none` |
| 12 | functions whose search_path is not public, pg_temp | `all 36` | `none` |
| 13 | a new function of postgres in public is executable by | `PUBLIC, anon, authenticated, postgres, service_role` | `postgres, service_role` |
| 14 | a new function of postgres elsewhere is executable by | `PUBLIC, postgres` | `postgres` |
| 15 | other roles whose new functions in public are open to anon or a signed-in user | `supabase_admin` | `supabase_admin` |

A set of functions is written `none`, `all 36`, or `30 of 36`; when it holds twelve names or fewer, they follow.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2, 3 or 4** differ — stop and report, with the names. Production has a function the repository does not know, or lacks one. The migration refuses to run (`does not know: …`, `does not find: …`): it would otherwise close a function that something may need, without a word.
- **5** is not `none` — stop and report. A function `postgres` does not own cannot be changed by this file.
- **6 to 12 already read as in the "after" column** — the migration, or part of it, is in the database. Read the ledger (below): if migration 03 is there, you are done.
- **6, 8, 9, 11 or 12 read something else** (for example `24 of 36`) — go on. Somebody already closed or pinned a few functions by hand; the migration sets all of them.
- **7** is not `none` — go on, and report it: a function the app needs is closed to it *today*. The migration opens it.
- **10** is not `none` — go on, and report it. The migration does not touch the service role.
- **13 or 14** differ — go on, and report what you see. The migration only takes `PUBLIC`, `anon` and `authenticated` out of those two lines.
- **15** is information. It is the platform's own role: nothing of the app is created by it, and this file cannot change it. Whatever it reads, go on.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_03_function_grants_lockdown.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_03_02_rpc_auth_null_guard, which is not applied` (code `SLM02`) | Checkpoint A0 is not done | apply migrations 01 and 02 first |
| `does not know: …` or `does not find: …` | lines 3 or 4 of the audit | stop and report the names |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `did not get the privileges it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. It reads as the "after" column. **Line 7 must read `none`**: a name there is a function the app needs and can no longer call — roll back.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: three rows, the last one `2026_10_11_03_function_grants_lockdown`.

3. See the refusal for yourself. This calls one of the twelve helpers as a request without a session would:

   ```bash
   supabase db query --linked 'do $check$ begin set local role anon; perform public.student_profile_for_slot(gen_random_uuid()); end $check$'
   ```

   The command must fail with `permission denied for function student_profile_for_slot`. That failure is the fix: before the migration the same command goes through.

4. See that a signed-in user still gets through. This opens every table of the app the way a signed-in user does, which is when the database checks the right to call the helpers of its policies. It reads no row and changes nothing:

   ```bash
   supabase db query --linked 'do $check$
   declare t record;
   begin
     set local role authenticated;
     for t in select tablename from pg_tables where schemaname = $s$public$s$ order by 1 loop
       execute format($q$select 1 from public.%I limit 0$q$, t.tablename);
     end loop;
   end $check$'
   ```

   It must **not** fail. `permission denied for function …` here names a helper a policy calls and a signed-in user cannot execute: roll back, and report the name.

5. Open the app that is deployed, on a phone or in a browser.

   As an athlete:
   - the training list shows the current block;
   - open the next session: the exercises and their sets are there;
   - tick a set, then untick it;
   - open Messages and Stats.

   As the coach:
   - the roster shows every athlete, with their programs;
   - open an athlete, then a session of their program;
   - open a session to review, and play a video if one has any;
   - open Messages.

   What a problem looks like: a list that should hold something is empty or shows an error, or a red message *You don't have permission to do that.* In the browser's developer tools (Network), the failed request answers `permission denied for function <name>`. Any of these: roll back, and report the name of the function.

Checkpoint A2 starts only once this is done.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_11_03_function_grants_lockdown.down.sql
```

**It reopens the findings.** Run it when, after the migration, the signed-in app answers `permission denied for function …` somewhere — the database tests call every helper and every policy as an athlete and as a coach, so this is not expected. Report the function, and re-apply the migration once the cause is known.

It gives back what the repository had before: the right to execute all 36 for `anon` and `authenticated`, and for `PUBLIC` on the 30 that had it; no `search_path` on 25 functions and `public` on 11; and a new function open to everyone again. No table and no row is touched, in either direction. The fix of migration 02 stays: the five coach functions still refuse a caller without a session.

It is refused (code `SLM04`) once a later migration is in the ledger: those create functions with grants of their own. Roll those back first, last applied first.

## From now on: a function you create by hand

A function created in the SQL editor after this migration can be called by `postgres` and by the service role only. The app cannot call it, and a policy that uses it fails for every signed-in user, until you say so:

```sql
grant execute on function public.my_function(uuid) to authenticated;
```

Give it a `search_path` as well (`set search_path = public, pg_temp` in its definition), and write the names in its body with their schema (`public.sessions`, not `sessions`).
