-- Audit for 2026_10_11_03_function_grants_lockdown. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                    before          after
--    1 running as                                             postgres        postgres
--    2 functions in public                                    36              36
--    3 functions the migration does not know                  none            none
--    4 functions the migration expects and does not find      none            none
--    5 functions not owned by postgres                        none            none
--    6 functions anon may execute (B2, L21)                   all 36          none
--    7 allow-listed functions a signed-in user may NOT execute  none          none
--    8 other functions a signed-in user may execute           all 17          none
--    9 functions PUBLIC may execute                           30 of 36        none
--   10 functions service_role may NOT execute                 none            none
--   11 functions without a search_path (L23)                  25 of 36        none
--   12 functions whose search_path is not public, pg_temp     all 36          none
--   13 a new function of postgres in public is executable by  PUBLIC, anon, authenticated, postgres, service_role
--                                                                             postgres, service_role
--   14 a new function of postgres elsewhere is executable by  PUBLIC, postgres   postgres
--   15 other roles whose new functions in public are open to anon or a signed-in user
--                                                             supabase_admin  supabase_admin
--
-- Lines 6, 8, 9, 11 and 12 are the findings: they read "none" after.
-- Line 7 is the one that must read "none" BEFORE AND AFTER: a name there after
-- the migration is a function the app needs and can no longer call.
-- Lines 3, 4 and 5 must read "none" before: the migration refuses to run
-- otherwise, and changes nothing.
-- Line 15 is information: the platform's own role, which this file cannot and
-- does not change. Nothing of the app is created by it.
--
-- A set is written "none", "all N", or "H of N" — followed by the names when
-- there are twelve or fewer.
with known (signature, kind) as (
  values
    -- the 12 helpers the policies call
    ('student_profile_for_slot(uuid)',            'allowed'),
    ('student_profile_for_session(uuid)',         'allowed'),
    ('student_profile_for_set_log(uuid)',         'allowed'),
    ('student_profile_for_goal(uuid)',            'allowed'),
    ('coach_profile_for_session(uuid)',           'allowed'),
    ('coach_profile_for_goal(uuid)',              'allowed'),
    ('profiles_are_coach_student(uuid, uuid)',    'allowed'),
    ('program_active_for_session(uuid)',          'allowed'),
    ('program_active_for_slot(uuid)',             'allowed'),
    ('program_is_own_draft(uuid)',                'allowed'),
    ('week_is_own_draft(uuid)',                   'allowed'),
    ('session_is_own_draft(uuid)',                'allowed'),
    -- the 7 RPCs the app calls
    ('adopt_swap(uuid, uuid, boolean)',           'allowed'),
    ('adopt_skip(uuid, boolean)',                 'allowed'),
    ('decline_promote_request(uuid)',             'allowed'),
    ('approve_program(uuid)',                     'allowed'),
    ('send_back_program(uuid)',                   'allowed'),
    ('save_draft_tree(jsonb)',                    'allowed'),
    ('move_session(uuid, uuid, uuid[], uuid[])',  'allowed'),
    -- the 17 trigger functions
    ('handle_new_user()',                         'trigger'),
    ('profiles_pin_immutable_columns()',          'trigger'),
    ('restrict_student_goal_update()',            'trigger'),
    ('pin_set_log_targets_for_student()',         'trigger'),
    ('pin_program_authoring_columns()',           'trigger'),
    ('lock_message_fields_on_update()',           'trigger'),
    ('lock_notification_fields_on_update()',      'trigger'),
    ('sync_session_performed_at()',               'trigger'),
    ('notify_coach_on_session_confirm()',         'trigger'),
    ('notify_coach_on_slot_deviation()',          'trigger'),
    ('notify_coach_on_promote_request()',         'trigger'),
    ('notify_coach_on_program_submit()',          'trigger'),
    ('notify_student_on_session_feedback()',      'trigger'),
    ('notify_recipient_on_chat_message()',        'trigger'),
    ('block_program_delete_with_logged_sets()',   'trigger'),
    ('block_week_delete_with_logged_sets()',      'trigger'),
    ('block_session_delete_with_logged_sets()',   'trigger')
),
fn as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
         pg_get_userbyid(p.proowner) as owner,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_may,
         exists (select 1
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_may,
         (select setting from unnest(p.proconfig) as setting where setting like 'search_path=%' limit 1) as search_path
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
),
f as (
  select fn.*, coalesce(known.kind, 'unknown') as kind
    from fn left join known using (signature)
),
-- One row per function and per check: is it in the set the check counts?
member (n, signature, hit) as (
            select  6, signature, anon_may                                    from f
  union all select  7, signature, not user_may                                from f where kind = 'allowed'
  union all select  8, signature, user_may                                    from f where kind <> 'allowed'
  union all select  9, signature, public_may                                  from f
  union all select 10, signature, not service_may                             from f
  union all select 11, signature, search_path is null                         from f
  union all select 12, signature, search_path is distinct from 'search_path=public, pg_temp' from f
),
tally as (
  select n,
         case
           when count(*) filter (where hit) = 0 then 'none'
           else case when count(*) filter (where hit) = count(*) then 'all ' || count(*)
                     else count(*) filter (where hit) || ' of ' || count(*) end
                || case when count(*) filter (where hit) <= 12
                        then ': ' || string_agg(signature, '; ' order by signature collate "C") filter (where hit)
                        else '' end
         end as value
    from member
   group by n
),
-- Who may execute a function `postgres` creates from now on: PostgreSQL's
-- built-in default (or the global entry that replaces it), plus what the
-- entry for the schema adds.
anywhere as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee
    from aclexplode(coalesce(
           (select d.defaclacl from pg_default_acl d
             where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'),
           acldefault('f', 'postgres'::regrole))) a
   where a.privilege_type = 'EXECUTE'
),
in_public as (
  select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee
    from pg_default_acl d
   cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
     and d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'functions in public',
          (select count(*)::text from f),
          '36'),
      (3, 'functions the migration does not know',
          (select coalesce(string_agg(signature, '; ' order by signature collate "C"), 'none') from f where kind = 'unknown'),
          'none'),
      (4, 'functions the migration expects and does not find',
          (select coalesce(string_agg(known.signature, '; ' order by known.signature collate "C"), 'none')
             from known where not exists (select 1 from fn where fn.signature = known.signature)),
          'none'),
      (5, 'functions not owned by postgres',
          (select coalesce(string_agg(signature || ' (' || owner || ')', '; ' order by signature collate "C"), 'none')
             from f where owner <> 'postgres'),
          'none'),
      (6, 'functions anon may execute (B2, L21)',
          coalesce((select value from tally where n = 6), 'none'),
          'all 36 before, none after'),
      (7, 'allow-listed functions a signed-in user may NOT execute',
          coalesce((select value from tally where n = 7), 'none'),
          'none, before and after'),
      (8, 'other functions a signed-in user may execute',
          coalesce((select value from tally where n = 8), 'none'),
          'all 17 before (the trigger functions), none after'),
      (9, 'functions PUBLIC may execute',
          coalesce((select value from tally where n = 9), 'none'),
          '30 of 36 before, none after'),
      (10, 'functions service_role may NOT execute',
          coalesce((select value from tally where n = 10), 'none'),
          'none, before and after'),
      (11, 'functions without a search_path (L23)',
          coalesce((select value from tally where n = 11), 'none'),
          '25 of 36 before, none after'),
      (12, 'functions whose search_path is not public, pg_temp',
          coalesce((select value from tally where n = 12), 'none'),
          'all 36 before, none after'),
      (13, 'a new function of postgres in public is executable by',
          (select coalesce(string_agg(grantee, ', ' order by grantee collate "C"), 'nobody')
             from (select grantee from anywhere union select grantee from in_public) g),
          'PUBLIC, anon, authenticated, postgres, service_role before; postgres, service_role after'),
      (14, 'a new function of postgres elsewhere is executable by',
          (select coalesce(string_agg(grantee, ', ' order by grantee collate "C"), 'nobody') from anywhere),
          'PUBLIC, postgres before; postgres after'),
      (15, 'other roles whose new functions in public are open to anon or a signed-in user',
          (select coalesce(string_agg(role, ', ' order by role collate "C"), 'none')
             from (select distinct pg_get_userbyid(d.defaclrole)::text as role
                     from pg_default_acl d
                    cross join lateral aclexplode(d.defaclacl) a
                    where d.defaclobjtype = 'f'
                      and d.defaclnamespace = 'public'::regnamespace
                      and d.defaclrole <> 'postgres'::regrole
                      and a.privilege_type = 'EXECUTE'
                      and pg_get_userbyid(a.grantee) in ('anon', 'authenticated')) r),
          'supabase_admin (the platform''s role: information, not changed)')
  ) as t (n, "check", value, expected)
 order by n;
