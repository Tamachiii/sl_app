-- Audit for 2026_10_16_24_indexes_cleanup. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 indexes that repeat a unique key (L28)                     the nine                    none
--    3 the unique keys that stand in for them                     all nine there              all nine there
--    4 foreign keys without an index (L28)                        the eight                   none
--    5 indexes of this migration                                  none                        the eight
--    6 what a deleted session does to the feedback message on it (N9)
--                                                                 the message keeps its id    the message loses it
--    7 messages that name a session that is gone (N9)             a number                    0
--    8 how often the nine were read since the statistics were reset
--                                                                 a list                      none
--
-- Lines 2, 4, 5 and 6 are the migration: they read as the "after" column
-- once it is applied.
--    3  MUST read `all nine there`: the migration refuses to drop an index
--       whose unique key is missing. A line that starts with MISSING: stop
--       and report it.
--    5  MUST read `none` before: an index of one of the eight names was made
--       by hand, and the migration refuses to run next to it.
--    6  MUST read `the message keeps its id` before. SOMETHING ELSE: stop
--       and report it — the migration refuses to replace another function.
--    7  feedback messages whose session was deleted: they link to nothing in
--       the conversation. The migration clears the link, as the foreign key
--       would have; the ids do not come back with the rollback.
--    8  idx_scan of pg_stat_user_indexes: a lookup that read one of the nine
--       reads its unique key from the migration on.
with nine (name, key) as (
  values ('idx_students_profile_id', 'students_profile_id_key'),
         ('idx_weeks_program_id', 'weeks_program_id_week_number_key'),
         ('idx_sessions_week_id', 'sessions_week_sort_order_unique'),
         ('idx_set_logs_slot_id', 'set_logs_exercise_slot_id_set_number_key'),
         ('idx_session_confirmations_session_id', 'session_confirmations_session_id_key'),
         ('idx_slot_comments_slot_id', 'slot_comments_exercise_slot_id_key'),
         ('idx_slot_deviations_slot_id', 'slot_deviations_exercise_slot_id_key'),
         ('idx_set_log_videos_set_log', 'set_log_videos_set_log_id_key'),
         ('bodyweight_logs_student_idx', 'bodyweight_logs_student_id_logged_on_key')
),
eight (name) as (
  values ('client_errors_user_created_idx'), ('exercise_slots_exercise_idx'), ('goals_coach_idx'),
         ('slot_comments_student_idx'), ('slot_deviations_student_idx'), ('slot_deviations_substitute_idx'),
         ('messages_sender_created_idx'), ('messages_recipient_created_idx')
),
-- A foreign key is indexed by an index that starts with its column: a whole
-- one, or one on the rows where the column is set.
unindexed as (
  select c.conrelid::regclass::text || '.' || a.attname as fk
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
     and not exists (
       select 1 from pg_index x
        where x.indrelid = c.conrelid and x.indkey[0] = c.conkey[1] and x.indisvalid
          and (x.indpred is null or pg_get_expr(x.indpred, x.indrelid) = '(' || a.attname || ' IS NOT NULL)'))
),
-- lock_message_fields_on_update as it is written today: ab633194… is the
-- text of the baseline, 9af522ec… the text of this migration.
lock_body as (
  select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g')) as body
    from pg_proc p
   where p.oid = to_regprocedure('public.lock_message_fields_on_update()')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'indexes that repeat a unique key (L28)',
          coalesce((select string_agg(name, ', ' order by name) from nine where to_regclass('public.' || name) is not null), 'none'),
          'the nine before, none after'),
      (3, 'the unique keys that stand in for them',
          coalesce('MISSING: ' || (select string_agg(key, ', ' order by key) from nine
                                    where not exists (select 1 from pg_index x
                                                       where x.indexrelid = to_regclass('public.' || key) and x.indisunique and x.indisvalid)),
                   'all nine there'),
          'all nine there, before and after — otherwise stop and report'),
      (4, 'foreign keys without an index (L28)',
          coalesce((select string_agg(fk, ', ' order by fk) from unindexed), 'none'),
          'the eight before, none after'),
      (5, 'indexes of this migration',
          coalesce((select string_agg(name, ', ' order by name) from eight where to_regclass('public.' || name) is not null), 'none'),
          'none before — otherwise stop and report; the eight after'),
      (6, 'what a deleted session does to the feedback message on it (N9)',
          coalesce(
            (select case b.body
                      when 'ab63319458c5d50a0dfedd9b09f8a354' then 'the message keeps its id'
                      when '9af522ec2a9f713ca074a7d20fadcd28' then 'the message loses it'
                      else 'SOMETHING ELSE: a text this migration does not know (md5 ' || b.body || ')'
                    end
               from lock_body b),
            'NOT THERE: no function lock_message_fields_on_update()'),
          'the message keeps its id before — otherwise stop and report; the message loses it after'),
      (7, 'messages that name a session that is gone (N9)',
          (select count(*)::text from public.messages m
            where m.session_id is not null
              and not exists (select 1 from public.sessions s where s.id = m.session_id)),
          'cleared by the migration: 0 after'),
      (8, 'how often the nine were read since the statistics were reset',
          coalesce((select string_agg(s.indexrelname || ': ' || s.idx_scan, ', ' order by s.indexrelname)
                      from pg_stat_user_indexes s
                      join nine on nine.name = s.indexrelname
                     where s.schemaname = 'public'), 'none'),
          'information; none after')
  ) as t (n, "check", value, expected)
 order by n;
