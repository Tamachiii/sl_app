# 26 — Two lists of the coach answered by the database: the sessions to review of each athlete, and the conversations

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_26_coach_list_rpcs.sql` |
| Audit | `supabase/audits/2026_10_16_26_coach_list_rpcs.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_26_coach_list_rpcs.down.sql` |
| Kind | optional · expand: adds 2 functions; no table, no column, no policy, no trigger, no row |
| Wave / checkpoint | 3 / C1 |
| Findings | L18, P9 (the database's half) |
| Needs | migration 25 |

**Without this migration nothing is missing.** The app that is deployed does not call the two functions. The version of the app that follows wave 3 calls them when they are there; where they are not, it reads the coach's sessions to review and the conversations page by page, in as many requests as the history needs — the same lists, slower to open. With the migration each list is one request, whatever the size of the history.

Safe with the app that is deployed today and with every version before it: nothing calls the two functions, and nothing that exists is changed.

## Whether to apply it

It is optional: at Checkpoint C1 it is **asked**, not applied with the others — the standing answer covers the required migrations only ([`docs/RUNBOOK.md`](../../RUNBOOK.md), "Who runs a checkpoint"). Skipping it breaks nothing, now or later: no migration after it needs it, and every version of the app works without it.

Applying it is recommended. It writes no row, holds no table, and the roster and the list of messages of the next version of the app open with one request each. Lines 11 and 14 of the audit say whether a list is already cut today.

## What it does

Two lists of the coach are folded by the app from the whole history, read row by row:

- **the sessions still to review** — the chips of the Athletes roster, the count of the Sessions feed — are counted from every confirmation of every athlete of the coach;
- **the conversations** are folded from every message of the account.

The API answers 1000 rows at most, and says nothing when it cuts: past 1000 confirmations the oldest sessions to review drop out of the counts; past 1000 messages the oldest conversations drop out of the list, with their unread messages (L18). And every opening of those screens downloads the whole history again (P9).

The migration adds two functions that only read:

1. **`coach_review_counts()`** — one row per athlete of the caller who has sessions to review: `student_id` (the athlete's link, `students.id`) and `to_review`. A session to review is a confirmed session that is neither reviewed nor archived, in a block out of the trash — what the app counts today. An athlete with nothing to review has no row.
2. **`my_conversations()`** — one row per account the caller has exchanged a message with, the newest conversation first: `counterpart_id`, `full_name` (empty when the caller may no longer read that profile — a former coach after a change of coach), `last_body`, `last_at`, `unread`, then the rest of the newest message: `last_id`, `last_sender_id`, `last_recipient_id`, `last_session_id`, `last_read_at`. Feedback counts as a message, as in the app.

They read with the rights of whoever calls them, and each names its caller: a coach reads the counts of their own athletes and their own conversations, and nothing else. A request without a user id gets nothing. Nothing else changes: no table, no rule, no row.

## What the deployed client does differently

Nothing. The app that is deployed does not call these functions.

**For somebody who calls the API by hand** (`POST /rest/v1/rpc/coach_review_counts`, `POST /rest/v1/rpc/my_conversations`):

| Who calls | `coach_review_counts` | `my_conversations` |
|---|---|---|
| a coach | one row per athlete of theirs with sessions to review | one row per account they exchanged a message with |
| an athlete | no row | their conversations: their coach, and a former coach without a name |
| the service role, the SQL editor | no row | no row |
| nobody signed in | `permission denied for function coach_review_counts` | `permission denied for function my_conversations` |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_26_coach_list_rpcs.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | the sessions to review of each athlete are counted by the database (coach_review_counts, L18) | `no` | `yes` |
| 3 | the conversations of an account are listed by the database (my_conversations, L18) | `no` | `yes` |
| 4 | functions of these names that the migration does not know | `none` | `none` |
| 5 | functions of this migration a request without a session may execute | `none` | `none` |
| 6 | functions of this migration a signed-in user may execute | `none` | `coach_review_counts(); my_conversations()` |
| 7 | functions of this migration that run as their owner | `none` | `none` |
| 8 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 9 | session confirmations | a number | the same number |
| 10 | … of sessions still to review, in a block out of the trash | a number | the same number |
| 11 | coaches whose sessions to review the app counts from more than 1000 confirmations (L18) | a number | the same number |
| 12 | messages | a number | the same number |
| 13 | conversations | a number | the same number |
| 14 | accounts whose conversations the app folds from more than 1000 messages (L18) | a number | the same number |

Lines 2, 3 and 6 are the migration. The audit never calls the two functions: it runs on a database that does not have them.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 or 3 already reads `yes`** — read the ledger (below). If migration 26 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **4** is not `none` — **stop and report the line.** A function with one of the two names and other arguments exists; the migration refuses to run next to it.
- **5, 7 or 8** is not `none`, or **6** is not `none` before the migration — same: stop and report.
- **9 to 14** — numbers. Line 10 is how many sessions wait for a review, every coach together. **Line 11 or 14 above `0`** is a coach whose counts, or an account whose list of conversations, the app that is deployed reads cut: the oldest sessions to review, or the oldest conversations, are missing from them today. The next version of the app reads them whole, with the migration or without it — with it, in one request.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_26_coach_list_rpcs.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_25_storage_video_policies, which is not applied` (code `SLM02`) | migration 25 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 to 4 of the audit: a function of one of the two names exists | stop and report the names |
| `does not find the columns its functions are written with: …` | a column of the tables the two functions read is not there under its name | stop and report the full message |
| `did not get the functions it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 and 3 read `yes` and line 6 lists the two functions; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty-five rows, the last one `2026_10_16_26_coach_list_rpcs` — twenty-six where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates two coaches and an athlete of the first, a block of three sessions the athlete has confirmed — one still to review, one reviewed, one archived — and two messages: the coach's, which the athlete has opened, and the athlete's answer, which the coach has not. Through the API's role, the coach, the athlete and the other coach each call the two functions. Then it fails **whatever happened**, so that nothing is kept, the three accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_stranger uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_open uuid := gen_random_uuid();
     v_reviewed uuid := gen_random_uuid();
     v_archived uuid := gen_random_uuid();
     v_who uuid;
     v_got text;
     v_counts text[] := array[]::text[];
     v_lists text[] := array[]::text[];
     v_result text;
   begin
     if to_regprocedure($m$public.coach_review_counts()$m$) is null
        or to_regprocedure($m$public.my_conversations()$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the two functions are not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-26-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_stranger, $m$sl-check-26-stranger@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-26-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id in (v_coach, v_stranger);
     if (select count(*) from public.profiles where id in (v_coach, v_stranger) and role = $m$coach$m$) <> 2 then
       raise exception $m$check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-26 block$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order) values
       (v_open, v_week, $m$open$m$, 0), (v_reviewed, v_week, $m$reviewed$m$, 1), (v_archived, v_week, $m$archived$m$, 2);
     insert into public.session_confirmations (session_id, student_id) values
       (v_open, v_athlete), (v_reviewed, v_athlete), (v_archived, v_athlete);
     update public.sessions set reviewed_at = now() where id = v_reviewed;
     update public.sessions set archived_at = now() where id = v_archived;
     insert into public.messages (sender_id, recipient_id, body, read_at, created_at) values
       (v_coach, v_athlete, $m$sl-check-26 welcome$m$, now(), now() - interval $m$2 minutes$m$),
       (v_athlete, v_coach, $m$sl-check-26 thanks$m$, null, now() - interval $m$1 minute$m$);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     foreach v_who in array array[v_coach, v_athlete, v_stranger] loop
       perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_who, $m$role$m$, $m$authenticated$m$)::text, true);
       select coalesce(string_agg(case when r.student_id = v_link then $m$athlete$m$ else $m$another$m$ end || $m$:$m$ || r.to_review,
                                  $m$,$m$ order by r.to_review), $m$none$m$)
         into v_got
         from public.coach_review_counts() r;
       v_counts := v_counts || v_got;
       select coalesce(string_agg(case r.counterpart_id when v_coach then $m$coach$m$ when v_athlete then $m$athlete$m$ else $m$another$m$ end
                                  || $m$:$m$ || r.unread || $m$:$m$ || coalesce(r.last_body, $m$-$m$),
                                  $m$,$m$ order by r.last_at desc), $m$none$m$)
         into v_got
         from public.my_conversations() r;
       v_lists := v_lists || v_got;
     end loop;
     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);

     v_result := case
       when v_counts[3] <> $m$none$m$ or v_lists[3] <> $m$none$m$
         then $m$NOT PROTECTED: another coach read sessions to review or conversations that are not theirs$m$
       when v_counts[2] <> $m$none$m$
         then $m$NOT PROTECTED: the athlete read sessions to review$m$
       when v_counts[1] <> $m$athlete:1$m$
         then $m$BROKEN: the coach counts $m$ || v_counts[1] || $m$, not athlete:1$m$
       when v_lists[1] <> $m$athlete:1:sl-check-26 thanks$m$
         then $m$BROKEN: the coach lists $m$ || v_lists[1] || $m$, not athlete:1:sl-check-26 thanks$m$
       when v_lists[2] <> $m$coach:0:sl-check-26 thanks$m$
         then $m$BROKEN: the athlete lists $m$ || v_lists[2] || $m$, not coach:0:sl-check-26 thanks$m$
       else $m$in place: a coach reads the sessions to review of each athlete and their conversations in one request each; the athlete reads their own conversation, and another coach nothing$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a coach reads the sessions to review of each athlete and their conversations in one request each; the athlete reads their own conversation, and another coach nothing`. Run before the migration, the same command fails with `… NOT THERE: the two functions are not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message. Nothing breaks: the app reads the lists without them.
   - `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 8 of the audit are then what says whether the migration is in place.

4. Nothing to look at in the app that is deployed: it does not use the functions.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_26_coach_list_rpcs.down.sql
```

It drops the two functions. No row is written or removed: they only read.

**Nothing breaks, whichever app is published.** The app that is deployed does not call them; the version that follows wave 3 reads the coach's sessions to review and conversations page by page without them — the lists open more slowly, and show the same thing. The reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

It is **not** refused while a later migration is in the ledger, unlike the rollbacks of the required migrations: this one is optional, and no migration may need it.
