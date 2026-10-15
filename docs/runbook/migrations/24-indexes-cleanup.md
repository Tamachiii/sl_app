# 24 — Nine indexes that repeat a unique key go; every foreign key has an index; a deleted session leaves its feedback message without it

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_24_indexes_cleanup.sql` |
| Audit | `supabase/audits/2026_10_16_24_indexes_cleanup.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_24_indexes_cleanup.down.sql` |
| Kind | required · drops 9 indexes, adds 8, replaces 1 trigger function; clears the session of the messages that name one that is gone |
| Wave / checkpoint | 3 / C1 |
| Findings | L28, P62 (its index half), N9 |
| Needs | migration 23 |

Safe with the app that is deployed today and with every version before it: an index changes how fast the database finds a row, never which rows a request gets.

## What it does

**Indexes (L28, P62).** The database advisors of the Supabase dashboard list three things about the indexes of the app:

- **Nine indexes repeat a unique key** of their table: the unique key already starts with the same column, and a lookup of that column reads it. Every write of those tables updated both, for the work of one. The migration drops the nine: `idx_students_profile_id`, `idx_weeks_program_id`, `idx_sessions_week_id`, `idx_set_logs_slot_id`, `idx_session_confirmations_session_id`, `idx_slot_comments_slot_id`, `idx_slot_deviations_slot_id`, `idx_set_log_videos_set_log`, `bodyweight_logs_student_idx` — after checking that the unique key that stands in for each is there.
- **Foreign keys without an index**: deleting the row such a key points at — an account, an exercise — reads the whole table that holds it. The migration adds one for each: the errors of an account (by date, which is also what the cap of [migration 22](22-client-errors-scope.md) counts), the exercise of a session, the coach of a goal, the athlete of a note and of a swap, the exercise of a swap.
- **The conversation**: two indexes on the messages, by sender and by recipient, newest first (P62) — the second side of the foreign keys of a message, too.

The six indexes the advisors call *unused* stay: whether they are used is measured over the weeks after the policies of wave 4.

**A deleted session and its feedback message (N9).** The feedback you write at the end of a review is a message that names its session. When a session is deleted, its message was meant to lose that link and stay in the conversation as a plain message. The rule that keeps a message as it was written put the link back, so the message named a session that no longer exists. From this migration on:

1. **Deleting a session takes the link off its feedback message**; the message stays.
2. **Nobody else can take it off** while the session exists, as before.
3. **The messages that already name a session that is gone lose that link** now — what deleting the session should have done. The audit counts them first; the links do not come back with the rollback.

A feedback message without its session is a plain message: as for any message of yours, you may delete it.

## What the deployed client does differently

**Nothing you can see**, apart from a feedback message whose session was deleted: it shows in the conversation as a plain message, without the card of the session it no longer has.

Nothing changes in what any request answers.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_24_indexes_cleanup.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | indexes that repeat a unique key (L28) | the nine names | `none` |
| 3 | the unique keys that stand in for them | `all nine there` | `all nine there` |
| 4 | foreign keys without an index (L28) | eight names | `none` |
| 5 | indexes of this migration | `none` | the eight names |
| 6 | what a deleted session does to the feedback message on it (N9) | `the message keeps its id` | `the message loses it` |
| 7 | messages that name a session that is gone (N9) | a number | `0` |
| 8 | how often the nine were read since the statistics were reset | a list | `none` |

Lines 2, 4, 5 and 6 are the migration; line 7, the rows it writes.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `none`, **5** names the eight or **6** reads `the message loses it` — read the ledger (below). If migration 24 is there, you are done. If it is not, something was changed by hand: stop and report.
- **2** names fewer than nine — one was dropped by hand. The migration drops the others.
- **3** starts with `MISSING:` — **stop and report the line.** A unique key is not there, and the migration refuses to drop the index that stands for it.
- **4** — the eight before: `client_errors.user_id, exercise_slots.exercise_id, goals.coach_id, messages.recipient_id, messages.sender_id, slot_comments.student_id, slot_deviations.student_id, slot_deviations.substitute_exercise_id`. Another one: stop and report.
- **5** is not `none` — **stop and report the line.** An index of one of the eight names was made by hand.
- **6** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.** The function is not the one of the baseline, and the migration refuses to replace it.
- **7** — any number: feedback messages whose session was deleted. [The messages that lose their session](#the-messages-that-lose-their-session) lists them.
- **8** — any numbers: how many lookups read each of the nine. From the migration on they read its unique key.

## The messages that lose their session

For line 7 of the audit — the messages the migration takes the link off, before it runs:

```bash
supabase db query --linked "select ps.full_name as sender, pr.full_name as recipient, m.created_at, left(m.body, 80) as message, m.session_id as session_that_is_gone, m.id as message_id from public.messages m join public.profiles ps on ps.id = m.sender_id join public.profiles pr on pr.id = m.recipient_id where m.session_id is not null and not exists (select 1 from public.sessions s where s.id = m.session_id) order by m.created_at"
```

Nothing to do about them: the session is gone, and the message stays where it is in the conversation. After the migration the same command lists nothing.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_24_indexes_cleanup.sql
```

It holds the thirteen tables it touches — the tree of a block, the messages, the goals, the bodyweights, the errors — against reads and writes while it builds the eight indexes: a second or two. A request of the app in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_23_library_read_follows_program, which is not applied` (code `SLM02`) | migration 23 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not drop the nine: …` | line 3 of the audit, or an index of one of the nine names that is not the one of the baseline | stop and report the full message |
| `would not create: … is already there` | line 5 of the audit | stop and report the names |
| `would not replace lock_message_fields_on_update: …` | line 6 of the audit | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | a request held one of the tables for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2, 4 to 8 read as the "after" column; line 3 is unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty-three rows, the last one `2026_10_16_24_indexes_cleanup` — twenty-four where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates a coach and an athlete, and a block with one session the athlete has confirmed. Through the API's role, as the coach, it writes the feedback of that session. As the athlete it opens the message and tries to take the session off it. As the coach it deletes the session. Then it reads the message, and counts the nine indexes and the foreign keys without one. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_message uuid;
     v_kept uuid;
     v_read boolean;
     v_deleted integer;
     v_refused boolean := false;
     v_after uuid;
     v_left integer;
     v_odd text := $m$$m$;
     v_nine integer;
     v_unindexed text;
     v_result text;
   begin
     if to_regclass($m$public.messages_sender_created_idx$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the indexes are as they were, and a deleted session stays named by its feedback$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-24-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-24-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-24 block$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.session_confirmations (session_id, student_id, performed_on) values (v_session, v_athlete, current_date);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       insert into public.messages (sender_id, recipient_id, body, session_id)
         values (v_coach, v_athlete, $m$sl-check-24 good session$m$, v_session) returning id into v_message;
     exception when others then
       v_odd := v_odd || $m$, the feedback: $m$ || sqlerrm;
     end;

     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       update public.messages set read_at = now(), session_id = null where id = v_message;
     exception when others then
       v_odd := v_odd || $m$, opening it: $m$ || sqlerrm;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select m.session_id, m.read_at is not null into v_kept, v_read from public.messages m where m.id = v_message;

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       delete from public.sessions where id = v_session;
       get diagnostics v_deleted = row_count;
     exception
       when foreign_key_violation then
         v_refused := true;
       when others then
         v_odd := v_odd || $m$, deleting the session: $m$ || sqlerrm;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select m.session_id into v_after from public.messages m where m.id = v_message;
     select count(*) into v_left from public.messages m where m.id = v_message;
     select count(*) into v_nine from pg_class c
      where c.relnamespace = $m$public$m$::regnamespace and c.relkind = $m$i$m$
        and c.relname in ($m$idx_students_profile_id$m$, $m$idx_weeks_program_id$m$, $m$idx_sessions_week_id$m$,
                          $m$idx_set_logs_slot_id$m$, $m$idx_session_confirmations_session_id$m$, $m$idx_slot_comments_slot_id$m$,
                          $m$idx_slot_deviations_slot_id$m$, $m$idx_set_log_videos_set_log$m$, $m$bodyweight_logs_student_idx$m$);
     select string_agg(c.conrelid::regclass::text || $m$.$m$ || a.attname, $m$, $m$ order by c.conrelid::regclass::text, a.attname) into v_unindexed
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = $m$f$m$ and c.connamespace = $m$public$m$::regnamespace
        and not exists (select 1 from pg_index x
                         where x.indrelid = c.conrelid and x.indkey[0] = c.conkey[1] and x.indisvalid
                           and (x.indpred is null or pg_get_expr(x.indpred, x.indrelid) = $m$($m$ || a.attname || $m$ IS NOT NULL)$m$));

     v_result := case
       when v_odd <> $m$$m$
         then $m$BROKEN: $m$ || substr(v_odd, 3)
       when v_kept is distinct from v_session
         then $m$NOT PROTECTED: the athlete took the session off a feedback message$m$
       when not v_read
         then $m$BROKEN: the athlete could not open the feedback$m$
       when v_refused or v_after is not null
         then $m$BROKEN: the feedback message still names the session that was deleted$m$
       when v_deleted is distinct from 1
         then $m$BROKEN: the coach could not delete the session$m$
       when v_left <> 1
         then $m$BROKEN: the feedback message went with its session$m$
       when v_nine > 0
         then $m$BROKEN: $m$ || v_nine || $m$ of the nine indexes are still there$m$
       when v_unindexed is not null
         then $m$BROKEN: foreign keys without an index: $m$ || v_unindexed
       else $m$in place: no index repeats a unique key and every foreign key has one; a deleted session leaves its feedback message without it, and nobody else takes it off$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: no index repeats a unique key and every foreign key has one; a deleted session leaves its feedback message without it, and nobody else takes it off`. Run before the migration, the same command fails with `… NOT THERE: the indexes are as they were, and a deleted session stays named by its feedback` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 6 of the audit are then what says whether the migration is in place.

4. In the app, nothing to look at.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_24_indexes_cleanup.down.sql
```

It builds the nine indexes again, drops the eight, and puts back the function of the baseline: a feedback message keeps naming its session when the session is deleted (N9).

**The links the migration took off do not come back** — they named sessions that were gone. The list you kept before the migration is what they were.

Every app works either way. The only reasons to run this file are step 3 answering `BROKEN` or `NOT PROTECTED`, or a migration applied to the wrong project. It holds the same thirteen tables for as long as it builds nine indexes.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.
