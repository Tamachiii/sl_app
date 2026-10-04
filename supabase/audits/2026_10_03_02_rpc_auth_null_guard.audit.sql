-- Audit for 2026_10_03_02_rpc_auth_null_guard. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--   check                                              before        after
--   1 running as                                       postgres      postgres
--   2 coach RPCs found                                 the five      the five
--   3 coach RPCs that run without a session (P1)       the five      none
--   4 coach RPCs a signed-in user cannot execute       none          none
--   5 coach RPCs not SECURITY DEFINER + search_path    none          none
--   6 coach RPCs not owned by postgres                 none          none
--   7 coach RPCs anon may execute                      the five      the five
--   8 push warnings worded as in production (L29)      both          both
--
-- Line 3 is the finding: "the five" before, "none" after. Line 7 stays as it
-- is until migration 03 — once line 3 reads "none", the EXECUTE of `anon`
-- opens nothing: the function refuses in its first lines.
--
-- Line 2 must list exactly these five, with these arguments:
--   adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean);
--   approve_program(uuid); decline_promote_request(uuid); send_back_program(uuid)
-- A sixth entry is the same function with other arguments: the migration
-- refuses to run, because it would fix one copy and leave the other open.
with rpc as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
         p.prosrc like '%auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid()%' as refuses_no_session,
         p.prosecdef
           and exists (select 1 from unnest(p.proconfig) as setting where setting like 'search_path=%') as definer_with_path,
         pg_get_userbyid(p.proowner) as owner,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_may
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('adopt_swap', 'adopt_skip', 'decline_promote_request',
                       'approve_program', 'send_back_program')
)
select "check", value, expected
  from (values
    (1, 'running as',
        current_user::text,
        'postgres'),
    (2, 'coach RPCs found',
        (select coalesce(string_agg(signature, '; ' order by signature), 'none') from rpc),
        'adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean); approve_program(uuid); '
        || 'decline_promote_request(uuid); send_back_program(uuid)'),
    (3, 'coach RPCs that run without a session (P1)',
        (select coalesce(string_agg(signature, '; ' order by signature), 'none') from rpc where not refuses_no_session),
        'the five of line 2 before, none after'),
    (4, 'coach RPCs a signed-in user cannot execute',
        (select coalesce(string_agg(signature, '; ' order by signature), 'none') from rpc where not authenticated_may),
        'none'),
    (5, 'coach RPCs that are not SECURITY DEFINER with a search_path',
        (select coalesce(string_agg(signature, '; ' order by signature), 'none') from rpc where not definer_with_path),
        'none'),
    (6, 'coach RPCs not owned by postgres',
        (select coalesce(string_agg(signature || ' (' || owner || ')', '; ' order by signature), 'none')
           from rpc where owner <> 'postgres'),
        'none'),
    (7, 'coach RPCs anon may execute',
        (select coalesce(string_agg(signature, '; ' order by signature), 'none') from rpc where anon_may),
        'the five of line 2, until migration 03 (harmless once line 3 reads none)'),
    (8, 'push warnings worded "send-push fan-out (…) failed" (L29)',
        (select coalesce(string_agg(p.proname, '; ' order by p.proname), 'none')
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('notify_coach_on_program_submit', 'send_back_program')
            and p.prosrc like '%send-push fan-out (program %'),
        'notify_coach_on_program_submit; send_back_program')
  ) as t(n, "check", value, expected)
 order by n;
