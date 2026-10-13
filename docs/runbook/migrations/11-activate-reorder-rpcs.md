# 11 — A block is activated, and sessions and phases are reordered, in one request each

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_11_activate_reorder_rpcs.sql` |
| Audit | `supabase/audits/2026_10_13_11_activate_reorder_rpcs.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_11_activate_reorder_rpcs.down.sql` |
| Kind | required · expand: adds 3 functions; no table, no column, no policy, no trigger, no row |
| Wave / checkpoint | 1 / A3 |
| Findings | P16, P51 (the database's half) |
| Needs | migration 10 |

Safe with the app that is deployed today: nothing calls the three functions yet, and nothing that exists is changed. The version of the app that follows wave 1 calls them — this migration must be in the database before that version is published, and the deploy checks the ledger for it.

## What it does

Three things a coach does are several requests today, and each request is saved on its own:

- ***Set active* is two requests.** The block the athlete was training is switched off, then the chosen one is switched on. When the second request is lost — the network, a tab that closes — the athlete has **no** active block: their training page says *No program assigned yet*, and every set they log is refused, the ones waiting on their phone included (P16).
- **Reordering the sessions of a phase is two requests per session**, and reordering the phases of a block two per phase: each one is parked at a number above 100000, then each one is given its place. A request lost half-way, or a second drag that starts before the first has finished, leaves sessions numbered 100000 and more, or an order nobody chose — and that number is the order of the athlete's list. A phase left like that can no longer be reordered by the app that is deployed (P51).

The migration adds one function for each, which does the whole thing or nothing:

1. **`activate_program(p_program_id)`** switches the athlete's other blocks off and this one on. It refuses a draft and a block in the trash before it writes anything. A block in the trash that still holds the active place is switched off with the rest.
2. **`reorder_sessions(p_week_id, p_ids)`** gives the sessions of one phase the order of the list.
3. **`reorder_weeks(p_program_id, p_ids)`** gives the phases of one block the order of the list.

The two reorders ask for **every** session of the phase (or every phase of the block), once each — archived sessions included — and refuse any other list. A phase that an interrupted reorder left at 100000 and more is put right by the same call.

They give nobody a right they did not have: they run with the rights of whoever calls them, so the coach of an athlete gets through and nobody else does. Nothing else changes: no table, no rule, no row.

## What the deployed client does differently

Nothing. The app that is deployed does not call these functions and goes on with its own requests, which work as before.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| nobody signed in | `permission denied for function activate_program` (or `reorder_sessions`, `reorder_weeks`) |
| a coach, for a block of somebody else's athlete — or an id that is no block | `program_not_found`; for a phase, `week_not_found` |
| the athlete of the block | `not authorized` |
| the coach, for a draft / for a block in the trash | `program_is_draft` / `program_in_trash` |
| the coach, with a list that is not exactly the sessions of the phase, or the phases of the block | `reorder_ids_mismatch` — the details count what is missing, foreign or repeated |

In every one of those cases nothing was written.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_11_activate_reorder_rpcs.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | a block is activated in one request (activate_program, P16) | `no` | `yes` |
| 3 | the sessions of a phase are reordered in one request (reorder_sessions, P51) | `no` | `yes` |
| 4 | the phases of a block are reordered in one request (reorder_weeks, P51) | `no` | `yes` |
| 5 | functions of these names that the migration does not know | `none` | `none` |
| 6 | functions of this migration a request without a session may execute | `none` | `none` |
| 7 | functions of this migration a signed-in user may execute | `none` | `activate_program(uuid); reorder_sessions(uuid, uuid[]); reorder_weeks(uuid, uuid[])` |
| 8 | functions of this migration that run as their owner | `none` | `none` |
| 9 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 10 | athletes with a block and none active | a number | the same number |
| 11 | active blocks that are in the trash | `0` | `0` |
| 12 | sessions numbered 100000 or more | `0` | `0` |
| 13 | phases numbered 100000 or more | `0` | `0` |

Lines 10 to 13 are what a lost request may have left behind until now. The migration changes none of them, and none of them stops it.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 to 4 already read `yes`** — read the ledger (below). If migration 11 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **5** is not `none` — **stop and report the line.** A function with one of the three names and other arguments exists; the migration refuses to run next to it.
- **6, 8 or 9** is not `none`, or **7** is not `none` before the migration — same: stop and report.
- **10** is not `0` — go on, and read [Athletes without an active block](#athletes-without-an-active-block) afterwards.
- **11** is not `0` — go on, and read [A block in the trash that is still active](#a-block-in-the-trash-that-is-still-active) afterwards.
- **12 or 13** is not `0` — go on, and read [Sessions or phases left parked](#sessions-or-phases-left-parked) afterwards: the migration is what repairs them.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_11_activate_reorder_rpcs.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_10_goals_fk_coach_links, which is not applied` (code `SLM02`) | migration 10 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 to 5 of the audit: a function of one of the three names exists | stop and report the names |
| `does not find the columns its functions are written with: …` | a column of `programs`, `weeks` or `sessions` is not there under its name | stop and report the full message |
| `did not get the functions it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 to 4 read `yes` and line 7 lists the three functions; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: eleven rows, the last one `2026_10_13_11_activate_reorder_rpcs`.

3. See it for yourself. This creates a coach and an athlete, with a block that is active and a second one of two phases and three sessions. Through the API's role, as the athlete, it tries to set the second block active; as the coach, it sets it active, reorders its sessions and its phases, and tries a list that leaves a session out. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_first uuid := gen_random_uuid();
     v_next uuid := gen_random_uuid();
     v_w1 uuid := gen_random_uuid();
     v_w2 uuid := gen_random_uuid();
     v_s1 uuid := gen_random_uuid();
     v_s2 uuid := gen_random_uuid();
     v_s3 uuid := gen_random_uuid();
     v_active uuid[];
     v_sessions uuid[];
     v_phases uuid[];
     v_answer text;
   begin
     if to_regprocedure($m$public.activate_program(uuid)$m$) is null
        or to_regprocedure($m$public.reorder_sessions(uuid, uuid[])$m$) is null
        or to_regprocedure($m$public.reorder_weeks(uuid, uuid[])$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the three functions are not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-11-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-11-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.programs (id, student_id, name, is_active) values
       (v_first, v_link, $m$sl-check-11 first$m$, true),
       (v_next, v_link, $m$sl-check-11 next$m$, false);
     insert into public.weeks (id, program_id, week_number) values (v_w1, v_next, 1), (v_w2, v_next, 2);
     insert into public.sessions (id, week_id, title, sort_order) values
       (v_s1, v_w1, $m$one$m$, 0), (v_s2, v_w1, $m$two$m$, 1), (v_s3, v_w1, $m$three$m$, 2);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       perform public.activate_program(v_next);
       v_answer := $m$NOT PROTECTED: an athlete set a block active$m$;
     exception when insufficient_privilege then
       null;
     end;

     if v_answer is null then
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
       perform public.activate_program(v_next);
       perform public.reorder_sessions(v_w1, array[v_s3, v_s1, v_s2]);
       perform public.reorder_weeks(v_next, array[v_w2, v_w1]);
       begin
         perform public.reorder_sessions(v_w1, array[v_s1, v_s2]);
         v_answer := $m$BROKEN: a list that leaves a session out was accepted$m$;
       exception when raise_exception then
         null;
       end;
     end if;

     if v_answer is null then
       select array_agg(p.id order by p.id) into v_active
         from public.programs p where p.student_id = v_link and p.is_active;
       select array_agg(s.id order by s.sort_order) into v_sessions
         from public.sessions s where s.week_id = v_w1;
       select array_agg(w.id order by w.week_number) into v_phases
         from public.weeks w where w.program_id = v_next;
       v_answer := case
         when v_active is distinct from array[v_next]
           then $m$BROKEN: after activate_program the chosen block is not the one active block of the athlete$m$
         when v_sessions is distinct from array[v_s3, v_s1, v_s2]
           then $m$BROKEN: after reorder_sessions the sessions are not in the order of the list$m$
         when v_phases is distinct from array[v_w2, v_w1]
           then $m$BROKEN: after reorder_weeks the phases are not in the order of the list$m$
         else $m$in place: a coach sets a block active and reorders its sessions and its phases in one request each, and an athlete does not$m$
       end;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a coach sets a block active and reorders its sessions and its phases in one request each, and an athlete does not`. Run before the migration, the same command fails with `… NOT THERE: the three functions are not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 9 of the audit are then what says whether the migration is in place.

4. Nothing to look at in the app that is deployed: it does not use the functions.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_11_activate_reorder_rpcs.down.sql
```

It drops the three functions. No row is written: a block that was set active stays active, and sessions and phases keep the order they were given.

**Not once the version of the app that follows wave 1 is published.** That version sets a block active and reorders through these functions and through nothing else: without them each of those gestures fails, for every coach, until the migration is applied again. Before that, nothing calls them, and the only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Athletes without an active block

For line 10 of the audit: athletes who have at least one approved block out of the trash, and none that is active. That is what an athlete looks like between two blocks — and it is also what a *Set active* whose second request was lost leaves behind. The athlete sees *No program assigned yet*, and the roster shows them with *No program*. List them:

```bash
supabase db query --linked "select pr.full_name as athlete, coach.full_name as coach, count(*) as blocks, max(p.created_at)::date as newest_block from public.students st join public.profiles pr on pr.id = st.profile_id join public.profiles coach on coach.id = st.coach_id join public.programs p on p.student_id = st.id where p.deleted_at is null and p.status = 'approved' and not exists (select 1 from public.programs a where a.student_id = st.id and a.is_active and a.deleted_at is null) group by st.id, pr.full_name, coach.full_name order by 1"
```

One row per athlete. Nothing to repair in the database: tell the coach, who opens each athlete and sets the right block active — or leaves it, when the athlete is between two blocks.

## A block in the trash that is still active

For line 11 of the audit. A block that is deleted in the app is switched off as it goes to the trash, so `0` is expected. One that is in the trash **and** active holds its athlete's one active place while no screen shows it: the athlete sees *No program assigned yet*. List them:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, p.deleted_at from public.programs p join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where p.is_active and p.deleted_at is not null order by 1, 2"
```

Switch them off — the blocks stay in the trash, and nothing else is written:

```bash
supabase db query --linked "update public.programs set is_active = false where is_active and deleted_at is not null returning name"
```

Then run the audit again: line 11 reads `0`, and each of those athletes is now counted on line 10 — the coach sets the right block active. (*Set active* on another block does the same in one gesture, with the app that is deployed and with `activate_program` alike: both switch off every other block of the athlete, the one in the trash included.)

## Sessions or phases left parked

For lines 12 and 13 of the audit: sessions (or phases) that an interrupted reorder left numbered 100000 and more. They are shown in the order of their numbers, so the athlete and the coach see an order — possibly one nobody chose — and the app that is deployed can no longer reorder that phase: it answers *Two sessions ended up in the same slot — reload and try again.* every time, and may answer the same when a session is dragged out of that phase or into it. List the phases concerned:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, w.week_number as phase_number, count(*) as sessions, count(*) filter (where s.sort_order >= 100000) as parked from public.sessions s join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id group by pr.full_name, p.name, w.id, w.week_number having count(*) filter (where s.sort_order >= 100000) > 0 order by 1, 2, 3"
```

and the blocks whose phases are parked:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, count(*) as phases, count(*) filter (where w.week_number >= 100000) as parked from public.weeks w join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id group by pr.full_name, p.id, p.name having count(*) filter (where w.week_number >= 100000) > 0 order by 1, 2"
```

**After the migration**, renumber them. Each statement keeps the order that is on screen today and numbers it again from the start — it changes no order, and touches no other phase or block:

```bash
supabase db query --linked "select w.id as phase, public.reorder_sessions(w.id, array(select s.id from public.sessions s where s.week_id = w.id order by s.sort_order, s.id)) as renumbered from public.weeks w where exists (select 1 from public.sessions s where s.week_id = w.id and s.sort_order >= 100000)"
```

```bash
supabase db query --linked "select p.id as block, public.reorder_weeks(p.id, array(select w.id from public.weeks w where w.program_id = p.id order by w.week_number, w.id)) as renumbered from public.programs p where exists (select 1 from public.weeks w where w.program_id = p.id and w.week_number >= 100000)"
```

Each returns one row per phase (or block) it renumbered. Then run the audit again: lines 12 and 13 read `0`. Tell the coach of the athletes listed above to look at the order of those sessions: it is the one they saw, which may not be the one they meant.
