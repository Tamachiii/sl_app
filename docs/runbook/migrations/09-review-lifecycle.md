# 09 — A review needs a confirmation, and closes it

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_09_review_lifecycle.sql` |
| Audit | `supabase/audits/2026_10_13_09_review_lifecycle.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_09_review_lifecycle.down.sql` |
| Kind | required · adds 5 functions and 4 triggers, replaces 3 policies and 1 function, opens 1 function to signed-in users; **deletes the notifications that are stale** (lines 14 and 15 of the audit); no table, no column |
| Wave / checkpoint | 1 / A2 |
| Findings | P57, L12 (the database's half) |
| Needs | migration 08 |

Safe with the app that is deployed today: an athlete who trains, confirms and waits for feedback sees no difference, and neither does a coach who reviews a confirmed session.

Unlike migrations 04 to 08, it deletes rows: notifications you have not read, about a confirmation, a swap or a skip that no longer exists. The audit counts them first.

## What it does

A confirmation ("I have trained this session") and a review ("I have read it" — feedback, or *Finish without feedback*) were two facts that nothing tied together:

- **an athlete took a confirmation back after your review**, changed the session and confirmed it again: your feedback no longer spoke of what the session held. Migration 08 closed the sets; the confirmation itself could still be changed and removed;
- **you could review a session that was not confirmed** — from a *session completed* notification whose confirmation had been taken back since, or from the notification of a swap while the athlete was still training. Feedback and *Finish without feedback* both marked it as reviewed, and the session, confirmed later, never came into your *to review* list;
- **every confirm, undo, confirm left one more line in your bell**, each with a push of its own; a skip that was undone left its *off-plan* line behind. The lines led to a review page that said "not confirmed", or to an exercise with no swap in it.

From this migration on:

1. **A review closes the confirmation.** An athlete changes or takes back a confirmation only while the session is neither archived nor reviewed — the lock of migration 08, now on the confirmation too. It holds when the two happen in the same instant: one of the two requests is refused.
2. **A review needs a confirmation.** A signed-in user marks a session as reviewed, or sends feedback on it, only once its athlete has confirmed it.
3. **What is taken back takes its unread notifications with it.** A confirmation that is undone removes the unread *session completed* lines of that session from your bell; a swap or a skip that is removed takes its unread *off-plan* and *wants to keep it* lines. A line you have read stays: it is your history.
4. **The push of a confirmation replaces the previous one of the same session** on your lock screen instead of stacking under it.
5. **Once, when it is applied, it deletes the lines that are stale today** — what point 3 would have removed, had it been there (lines 14 and 15 of the audit). Nothing else is written: no session, no confirmation, no message.

**A session can still be confirmed after its review.** Sessions reviewed without a confirmation exist from before this migration (line 13 of the audit). They stay reviewed, they are archived, restored, renamed and moved as before, and their athlete can still confirm them — that is how such a session leaves their list of sessions to do. That confirmation is then final.

**The rules are for the app.** A request that carries no user — the SQL editor, a function called with the service-role key — is not judged: [a review is taken back by hand](#taking-a-review-back), and removing an account removes its confirmations.

## What the deployed client does differently

**An athlete, on a session that is not reviewed: nothing.** *Confirm session*, *Undo confirmation* and confirming again go through as before.

**An athlete, on a session you have reviewed:**

| What the athlete does | What they see |
|---|---|
| *Undo confirmation* (the app that is deployed still offers it) | no message: the page shows the session as not confirmed for a moment, then as confirmed again. Nothing was changed |
| their phone sends the confirmation a second time — a retry after a lost answer, a second device that still showed the session as to do | "You don't have permission to do that." The first confirmation stays as it was |
| *Confirm session*, on a session you reviewed before they confirmed it | it is confirmed, as before — and can no longer be undone |

**A coach, on a confirmed session: nothing.** Feedback and *Finish without feedback* work as before.

**A coach, on a session that is not confirmed** — reached from a notification, or from an archived session:

| What the coach does | What they see |
|---|---|
| *Send feedback* | the message is not sent. The box shows the database's sentence: `new row violates row-level security policy for table "messages"` |
| *Finish without feedback* | "You don't have permission to do that." The session is not marked as reviewed |

The next version of the app does not offer either on such a session: it says that the session is not confirmed.

**The bell.** A *session completed* line you have not read disappears when its athlete takes the confirmation back, and so does an *off-plan* line when the swap or the skip is removed.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_09_review_lifecycle.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | an athlete changes or takes back a confirmation only while its session is neither archived nor reviewed (P57) | `no` | `yes` |
| 3 | … and not while the review of that session is being written | `no` | `yes` |
| 4 | a signed-in user marks a session as reviewed only once its athlete has confirmed it | `no` | `yes` |
| 5 | … and sends feedback on a confirmed session only | `no` | `yes` |
| 6 | a confirmation that is taken back takes its unread notifications with it | `no` | `yes` |
| 7 | … and so does a swap or a skip that is removed (L12) | `no` | `yes` |
| 8 | the push of a confirmation is tagged by session | `no` | `yes` |
| 9 | functions of this migration a request without a session may execute | `none` | `none` |
| 10 | functions of this migration a signed-in user may execute | `none` | `session_is_confirmed(uuid); session_writable(uuid)` |
| 11 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 12 | policies that write these tables and that the migration does not know | `none` | `none` |
| 13 | sessions reviewed without a confirmation | a number | the same number |
| 14 | unread "session completed" notifications whose confirmation is gone | a number | `0` |
| 15 | unread "off-plan" notifications whose swap or skip is gone | a number | `0` |

Lines 14 and 15 are **the rows this migration deletes**. Note the two numbers: they are lines in a coach's bell, never read, about a confirmation, a swap or a skip that is no longer there. They do not come back with the rollback.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 to 8 already read `yes`** — the migration is in the database. Read the ledger (below): if migration 09 is there, you are done.
- **9** is not `none`, or **11** is not `none` — stop and report: a function of this migration exists already, and not as it should.
- **10** is not `none` before the migration — same: stop and report.
- **12** is not `none` — **stop and report the line.** It names a rule, made by hand, that lets somebody write confirmations or messages. The migration would undo itself rather than leave it next to the new ones.
- **13** is not `0` — go on. It counts the sessions of [Sessions reviewed without a confirmation](#sessions-reviewed-without-a-confirmation); the migration leaves them as they are.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_09_review_lifecycle.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_12_08_session_write_gates, which is not applied` (code `SLM02`) | migration 08 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …`, `did not get the policies it meant: …`, `did not get the triggers it meant: …` or `left a stale notification behind` | the file read its own result back and it was not the one described here — for the policies, most often line 12 of the audit | stop and report the full message |
| `canceling statement due to lock timeout` | the app was writing one of the tables at that moment | run the file again |

## After

1. Run the audit again. Lines 2 to 8 read `yes`, line 10 lists the two functions, lines 14 and 15 read `0`; the others are unchanged.

   The audit of migration 08, if you run it again from now on, lists `session_writable(uuid)` on its line 9 as well: this migration is what opened it to signed-in users.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: nine rows, the last one `2026_10_13_09_review_lifecycle`.

3. See it for yourself. This takes, in the blocks being trained, a session that is confirmed and reviewed, one that is confirmed and not reviewed, and one that is not confirmed. As the athlete of each — through the API's role — it takes back the confirmation of the second, then tries the first; as the coach, it tries to mark the third as reviewed. Then it fails **whatever happened**, so that nothing is kept. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_reviewed uuid;
     v_waiting uuid;
     v_open uuid;
     v_rows integer;
     v_answer text;
   begin
     select se.id into v_reviewed
       from public.sessions se
       join public.weeks w on w.id = se.week_id
       join public.programs p on p.id = w.program_id
      where p.is_active and p.deleted_at is null and se.archived_at is null
        and se.reviewed_at is not null
        and exists (select 1 from public.session_confirmations c where c.session_id = se.id)
      order by se.id limit 1;
     select se.id into v_waiting
       from public.sessions se
       join public.weeks w on w.id = se.week_id
       join public.programs p on p.id = w.program_id
      where p.is_active and p.deleted_at is null and se.archived_at is null
        and se.reviewed_at is null
        and exists (select 1 from public.session_confirmations c where c.session_id = se.id)
      order by se.id limit 1;
     select se.id into v_open
       from public.sessions se
       join public.weeks w on w.id = se.week_id
       join public.programs p on p.id = w.program_id
      where p.is_active and p.deleted_at is null and se.archived_at is null
        and se.reviewed_at is null
        and not exists (select 1 from public.session_confirmations c where c.session_id = se.id)
      order by se.id limit 1;
     if v_reviewed is null or v_waiting is null or v_open is null then
       raise exception $m$check only: the blocks being trained do not hold a reviewed session, a confirmed one that is not reviewed and one that is not confirmed, nothing to try$m$;
     end if;
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, public.student_profile_for_session(v_waiting), $m$role$m$, $m$authenticated$m$)::text, true);
     delete from public.session_confirmations where session_id = v_waiting;
     get diagnostics v_rows = row_count;
     if v_rows <> 1 then
       v_answer := $m$BROKEN: the athlete cannot take back a confirmation the coach has not reviewed$m$;
     else
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, public.student_profile_for_session(v_reviewed), $m$role$m$, $m$authenticated$m$)::text, true);
       delete from public.session_confirmations where session_id = v_reviewed;
       get diagnostics v_rows = row_count;
       if v_rows <> 0 then
         v_answer := $m$NOT PROTECTED: the athlete took back the confirmation of a reviewed session$m$;
       else
         perform set_config($m$request.jwt.claims$m$,
           json_build_object($m$sub$m$, public.coach_profile_for_session(v_open), $m$role$m$, $m$authenticated$m$)::text, true);
         begin
           update public.sessions set reviewed_at = now() where id = v_open and reviewed_at is null;
           get diagnostics v_rows = row_count;
           if v_rows = 1 then
             v_answer := $m$NOT PROTECTED: the coach marked as reviewed a session its athlete has not confirmed$m$;
           else
             v_answer := $m$NOT TRIED: the coach of the session that is not confirmed could not write it$m$;
           end if;
         exception when insufficient_privilege then
           if sqlerrm not like $m$%is not confirmed by its athlete%$m$ then
             raise;
           end if;
           v_answer := $m$protected: a confirmation is taken back until the review and not after, and a session that is not confirmed is not marked as reviewed$m$;
         end;
       end if;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: protected: a confirmation is taken back until the review and not after, and a session that is not confirmed is not marked as reviewed`. Run before the migration, the same command fails with `… NOT PROTECTED: the athlete took back the confirmation of a reviewed session` — and writes nothing either.

   `… BROKEN: the athlete cannot take back a confirmation the coach has not reviewed` after the migration means an athlete can no longer undo a confirmation at all: **roll back**, and report.

   `… NOT PROTECTED: …` after the migration, `… NOT TRIED: …`, or a message that does not start with `check only`: stop and report the full message. Nothing was written.

   `check only: the blocks being trained do not hold a reviewed session, a confirmed one that is not reviewed and one that is not confirmed, nothing to try` is no answer either way: lines 2 to 5 of the audit are then what says the rules are there. Go on to step 4.

4. In the app that is deployed, signed in as the **test athlete** — and only once step 3 has answered `protected`: confirm the next session, then undo the confirmation. Both go through as before. In the coach's bell the *completed* line appears, and is gone again after the undo.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_09_review_lifecycle.down.sql
```

**It reopens the findings.** Run it only if, after the migration, something is refused on a session that is **not** reviewed — step 3 answers `BROKEN`, an athlete can no longer confirm a session or undo a confirmation you have not reviewed, or your feedback on a confirmed session is not sent. The database tests replay those requests as the deployed app sends them, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

**"I cannot undo my confirmation" is not that case when you have reviewed the session**: that is the lock. If the athlete has a mistake to correct, [take the review back](#taking-a-review-back) for that one session and leave the migration in place.

It removes the four triggers and their functions, gives the three rules and the push of a confirmation back the text they had, and closes `session_writable` to signed-in users again. No table and no row is touched — **the notifications the migration deleted do not come back**, nor the ones removed while it was in place: they were about confirmations, swaps and skips that no longer exist.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Sessions reviewed without a confirmation

For line 13 of the audit: sessions marked as reviewed while their athlete had not confirmed them, or whose confirmation was taken back after the review. Through the app, no new one can appear from this migration on. List them:

```bash
supabase db query --linked "select se.id as session_id, pr.full_name as athlete, p.name as block, case when p.deleted_at is not null then 'in the trash' when p.is_active then 'being trained' else 'a past block' end as block_is, se.title as session, to_char(se.reviewed_at, 'YYYY-MM-DD') as reviewed_on, se.archived_at is not null as archived, exists (select 1 from public.messages m where m.session_id = se.id) as feedback_sent from public.sessions se join public.weeks w on w.id = se.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where se.reviewed_at is not null and not exists (select 1 from public.session_confirmations c where c.session_id = se.id) order by pr.full_name, se.reviewed_at"
```

One row per session. The migration changes none of them, and nothing has to be done for it:

- **of a past block, in the trash, or archived** — history. Leave it.
- **of the block being trained, not archived** — its athlete's app lists it as still to do. These are the sessions of line 13 of the audit of migration 08, and its page says what to do with each ([Sessions reviewed that their athlete has not confirmed](08-session-write-gates.md#sessions-reviewed-that-their-athlete-has-not-confirmed)): the athlete confirms it — the database accepts a confirmation on a reviewed session, and it is then final — or you take the review back, below.

## Taking a review back

The app has no way to reopen a reviewed session: the athlete's screen says that the coach has reviewed it and links to the messages. When an athlete has a real mistake to correct, the owner of the database reopens that one session, from the SQL editor, with the id of the session:

`update public.sessions set reviewed_at = null where id = '<id of the session>'`

The session is then open for its athlete again — sets, notes, videos, and the confirmation, which they can undo and make again — and it is back in the coach's *to review* list while it is confirmed.

A feedback message that was already sent stays in the conversation, and the app accepts no second one for the same session. To let the coach write a new one, remove the old message and the line it left in the athlete's bell:

`delete from public.messages where session_id = '<id of the session>'`

`delete from public.notifications where kind = 'session_feedback' and payload->>'session_id' = '<id of the session>'`

The coach then reviews the session again in the app, once it is confirmed. Do not set `reviewed_at` back by hand on a session that has no confirmation: the statement is accepted from the SQL editor, and the session joins the list of line 13.
