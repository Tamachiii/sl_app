# 14 — Table privileges: nothing without a session, rows for a signed-in user

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_14_table_grants_lockdown.sql` |
| Audit | `supabase/audits/2026_10_13_14_table_grants_lockdown.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_14_table_grants_lockdown.down.sql` |
| Kind | required · changes the privileges of two roles on the 20 tables, and what a new table starts with; no table, no column, no policy, no function, no row |
| Wave / checkpoint | 1 / A3 |
| Findings | L24 |
| Needs | migration 13 |

Safe with the app that is deployed today: a signed-in user reads and writes rows exactly as before. It is the last migration of Checkpoint A3; the version of the app that follows wave 1 is published after it.

## What it does

Supabase gives every table you create in `public` to three roles, in full: `anon` (a request that carries nothing but the anon key, which is in the app's JavaScript), `authenticated` (a signed-in user) and `service_role` (the Edge Functions). "In full" is eight privileges. Four are about rows — read, insert, update, delete — and the security policies decide, row by row, what each account gets. The four others are not about rows, and no policy applies to them:

- **TRUNCATE** empties a table at once. The policies do not see it, and neither do the guards that keep logged training from being deleted. One statement — `truncate public.profiles cascade` — empties every table of the app, and today both `anon` and any signed-in user have the right to run it.
- **MAINTAIN** rebuilds a table or its indexes, which locks them against everyone else while it runs.
- **TRIGGER** and **REFERENCES** are for somebody who creates triggers and foreign keys.

None of this can be used today: the API only reads, inserts, updates, deletes and calls functions. It is one mistake away — a function that runs a text it was handed with the caller's rights, or a table created without row-level security, which anyone holding the anon key could then read and write in full.

The migration does three things:

1. **Takes everything away from `anon`**, on every table of `public`. Nothing in this app is served without a session.
2. **Leaves a signed-in user the four privileges about rows, and takes the four others away.**
3. **Makes a table created later start the same way**: nothing for `anon`, the four about rows for a signed-in user. That holds for a table you create by hand in the SQL editor too. (The same for a sequence, the counter behind a numbered column: nothing for `anon`, the next number for a signed-in user. `public` has none today.)

The service role keeps everything. Nothing is granted to anyone: the migration only takes away.

## What the deployed client does differently

**Signed in: nothing.** Every request of the app is a read, an insert, an update, a delete or a function call, judged by the same policies as before.

**Without a session**, every table now refuses every request with `permission denied for table …`:

- a read of `bodyweight_logs`, `client_errors`, `exercise_library`, `goals`, `messages`, `notifications`, `profiles`, `programs`, `push_subscriptions`, `scheduled_pushes` or `students` used to return no row;
- the nine other tables have refused since migration 03, with a message that named a function. The message names the table now; the code (`42501`) is the same;
- an update or a delete used to be accepted and to change nothing. It is refused now.

The app does not send requests without a session. As with migration 03, there is one way to get there with the app that is deployed today: a session that has expired and could not be renewed, because the sign-in server did not answer while the database did. The app then sends its requests with the anon key. What changes in that state: a screen that was empty for want of rows now fails to load, and a save that the database accepted without writing anything — marking a notification as read, for instance — now shows *You don't have permission to do that.* Signing in again ends it. The draft case described on the page of migration 03 is unchanged.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_14_table_grants_lockdown.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | tables of public | `20` | `20` |
| 3 | views and sequences of public | `none` | `none` |
| 4 | tables, views and sequences not owned by postgres | `none` | `none` |
| 5 | tables without row-level security | `none` | `none` |
| 6 | tables a request without a session holds a privilege on (L24) | `all 20` | `none` |
| 7 | tables a signed-in user may NOT read, insert into, update and delete from | `none` | `none` |
| 8 | tables a signed-in user may TRUNCATE, or holds REFERENCES, TRIGGER or MAINTAIN on (L24) | `all 20` | `none` |
| 9 | tables PUBLIC holds a privilege on | `none` | `none` |
| 10 | tables the service role does NOT hold every privilege on | `none` | `none` |
| 11 | columns that carry a privilege of their own | `none` | `none` |
| 12 | sequences open to a request without a session, or that a signed-in user may read or set | `none` | `none` |
| 13 | a new table of postgres in public gives | `anon: everything; authenticated: everything; postgres: everything; service_role: everything` | `authenticated: DELETE, INSERT, SELECT, UPDATE; postgres: everything; service_role: everything` |
| 14 | a new sequence of postgres in public gives | `anon: everything; authenticated: everything; postgres: everything; service_role: everything` | `authenticated: USAGE; postgres: everything; service_role: everything` |
| 15 | other roles whose new tables in public are open to a request without a session | `supabase_admin` | `supabase_admin` |

A set of tables is written `none`, `all 20`, or `3 of 20`; when it holds twelve names or fewer, they follow. In lines 6 and 8 to 10 a view counts as a table. `everything` is every privilege there is.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** is not `20`, or **3** is not `none` — go on, and report the names. Production has a table, a view or a sequence the repository does not know. The migration treats it like the others: nothing without a session, rows for a signed-in user. A **view** in line 3 needs a look afterwards whatever happens: a view shows every row of its tables to whoever may read it, unless it was created `with (security_invoker = true)`.
- **4** is not `none` — stop and report. The migration refuses to run: it cannot change the privileges on a table `postgres` does not own.
- **5** is not `none` — go on, and report the names. A table without row-level security is read and written in full by every signed-in user, before and after this migration, which only takes the request without a session out of it.
- **6 and 8 already read `none`** — the migration, or part of it, is in the database. Read the ledger (below): if migration 14 is there, you are done.
- **6 or 8 read something else** (for example `17 of 20`) — go on. Somebody already took privileges away on a few tables by hand; the migration does it for all of them.
- **7** is not `none` — go on, and report the names: a table the app cannot fully read or write *today*. The migration does not change that, in either direction.
- **9** is not `none` — go on, and report. The migration takes what `PUBLIC` holds away as well.
- **10** is not `none` — go on, and report. The migration does not touch the service role.
- **11** is not `none` — go on, and report the names. A privilege given on single columns: the migration takes those of `anon` away with the rest, and leaves the read, insert and update ones of a signed-in user.
- **12** is not `none` — go on. It goes with line 3: the migration closes the sequence like the tables.
- **13 or 14** differ — go on, and report what you see. The migration only takes `anon` out of those two lines, and from `authenticated` what is not in the "after" column.
- **15** is information. It is the platform's own role: nothing of the app is created by it, and this file cannot change it. Whatever it reads, go on.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_14_table_grants_lockdown.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_13_ensure_claim_rpcs, which is not applied` (code `SLM02`) | migration 13 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `cannot change tables postgres does not own: …` | line 4 of the audit | stop and report the names |
| `did not get the privileges it meant: …` | the file read its own result back, and `anon` or a signed-in user still holds something it took away — a privilege somebody granted as another role | stop and report the full message |
| `did not get the default privileges it meant: …` | the same, for what a new table starts with | stop and report the full message |

## After

1. Run the audit again. It reads as the "after" column. **Line 7 must read what it read before — `none`**: a name that was not there before is a table the app can no longer read or write — roll back.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: fourteen rows, the last one `2026_10_13_14_table_grants_lockdown`.

3. See the refusal for yourself. This reads one table as a request without a session would:

   ```bash
   supabase db query --linked 'do $check$ begin set local role anon; perform 1 from public.profiles limit 1; end $check$'
   ```

   The command must fail with `permission denied for table profiles`. That failure is the fix: before the migration the same command goes through, and reads nothing.

4. See that a signed-in user still gets through. It is the check of migration 03: it opens every table of the app the way a signed-in user does, reads no row and changes nothing:

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

   It must **not** fail. `permission denied for table …` here names a table a signed-in user can no longer read: roll back, and report the name.

5. Open the app that is deployed, on a phone or in a browser.

   As an athlete:
   - the training list shows the current block;
   - open the next session, tick a set, then untick it;
   - open Messages.

   As the coach:
   - the roster shows every athlete;
   - open an athlete, then a session of their program;
   - open Messages.

   If you have both open at once: send a message as the coach. It appears on the athlete's screen without reloading — live updates read the table as the signed-in user, too.

   What a problem looks like: a list that should hold something is empty or shows an error, or a red message *You don't have permission to do that.* In the browser's developer tools (Network), the failed request answers `permission denied for table <name>`. Any of these: roll back, and report the name of the table.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_14_table_grants_lockdown.down.sql
```

**It reopens the finding.** Run it when, after the migration, the signed-in app answers `permission denied for table …` somewhere — the database tests read and write every table as an athlete and as a coach, so this is not expected. Report the table, and re-apply the migration once the cause is known.

It gives `anon` and a signed-in user back what Supabase gives by default: every privilege, on every table of `public` and on those created later. That is what the repository had before; if a privilege had been taken away by hand before the migration, the rollback grants it too. No table and no row is touched, in either direction, and the policies decide what is read and written as they did before.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## From now on: a table you create by hand

A table created in the SQL editor after this migration cannot be reached without a session. A signed-in user reads and writes it — **all of it, every account, until it has row-level security**:

```sql
alter table public.my_table enable row level security;
```

and then policies that say who reads and writes which rows. Without a policy, nobody but the service role does.

Two things to know:

- A **view** shows every row of its tables to whoever may read it, whatever the policies of those tables say. Create it `with (security_invoker = true)`, and it reads with the rights of the account that asks.
- A table created by another role than `postgres` — line 15 of the audit — still starts open to everyone, the request without a session included. After creating a table by hand, run the audit of this page once more: **lines 5 and 6 must read `none`**.
