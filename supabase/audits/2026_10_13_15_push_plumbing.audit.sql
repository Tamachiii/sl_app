-- Audit for 2026_10_13_15_push_plumbing. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 every push leaves through one function, with a time limit of 10 seconds (send_push_event, P35)
--                                                                 no                          yes
--    3 functions that read the vault or call pg_net themselves    the eleven (below)          send_push_event
--    4 functions that ask send_push_event for their push          none                        the eleven (below)
--    5 functions of these names that the migration does not know  none                        none
--    6 who may execute send_push_event                            no such function            postgres, service_role
--    7 an endpoint must be an address at a known push service (B3)
--                                                                 no                          yes
--    8 devices registered for notifications                       a number                    the same number
--    9 devices whose endpoint is NOT at a known push service      0                           0
--   10 vault: the address of the functions (app_functions_url)    set                         set
--   11 vault: the bearer of send-push                             app_service_role_key        app_service_role_key
--   12 pg_net takes a time limit (net.http_post … timeout_milliseconds)
--                                                                 yes                         yes
--
-- The eleven: adopt_skip, adopt_swap, approve_program,
-- decline_promote_request, notify_coach_on_program_submit,
-- notify_coach_on_promote_request, notify_coach_on_session_confirm,
-- notify_coach_on_slot_deviation, notify_recipient_on_chat_message,
-- notify_student_on_session_feedback, send_back_program.
--
-- Lines 2, 3, 4, 6 and 7 are the migration: they read as the "after" column
-- once it is applied.
-- Line 5 MUST read `none` before the migration, and line 12 `yes`: it
-- refuses to run otherwise. Stop and report the line.
-- Line 9 decides how line 7 reads afterwards, and stops nothing:
--    0     the rule is validated by the migration: line 7 reads `yes`.
--    N: …  N devices hold an endpoint the rule refuses; their HOSTS follow,
--          never the endpoint itself, which is a secret of its device. The
--          migration leaves those rows as they are, and line 7 then reads
--          `yes, for new and changed rows only (NOT validated)`. Read
--          docs/runbook/migrations/15-push-plumbing.md, "Devices whose
--          endpoint is not at a known push service" BEFORE applying: a host
--          that is a real push service means the list is one short.
-- Lines 10 and 11 are what send_push_event reads, and are not changed by the
-- migration. Neither prints a secret.
--   10  `set`, or `MISSING: no push is sent` — with the migration or without.
--   11  the name the bearer is stored under: `app_service_role_key` until
--       its owner renames it (the same page, "Renaming the secret"), then
--       `app_internal_bearer`. With both, it says whether they hold the same
--       value: `app_internal_bearer` is the one that is sent.
with eleven (signature) as (
  values ('public.notify_coach_on_session_confirm()'),
         ('public.notify_coach_on_slot_deviation()'),
         ('public.adopt_swap(uuid, uuid, boolean)'),
         ('public.adopt_skip(uuid, boolean)'),
         ('public.notify_coach_on_promote_request()'),
         ('public.decline_promote_request(uuid)'),
         ('public.approve_program(uuid)'),
         ('public.notify_coach_on_program_submit()'),
         ('public.send_back_program(uuid)'),
         ('public.notify_student_on_session_feedback()'),
         ('public.notify_recipient_on_chat_message()')
),
-- Every function of public, with what its text does about a push.
fn as (
  select p.oid,
         p.proname::text as name,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         p.prosrc ~ '(net[.]http_|vault[.])' as on_its_own,
         position('public.send_push_event(' in p.prosrc) > 0 as through_the_helper
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
),
-- send_push_event, when it is there.
helper as (
  select p.oid, p.prosrc as body
    from pg_proc p
   where p.oid = to_regprocedure('public.send_push_event(uuid, jsonb, jsonb)')
),
rule as (
  select c.convalidated as validated
    from pg_constraint c
   where c.conrelid = 'public.push_subscriptions'::regclass
     and c.conname = 'push_subscriptions_endpoint_known_push_service'
),
-- The devices the rule refuses, by host. The pattern is the one of the
-- migration, letter for letter.
elsewhere as (
  select coalesce(nullif(substring(ps.endpoint from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)'), ''), 'not a URL') as host
    from public.push_subscriptions ps
   where ps.endpoint !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/'
),
hosts as (
  select host, count(*) as devices from elsewhere group by host
),
-- The secrets send_push_event reads: whether each is there and not empty.
-- The values are compared, never shown.
secret as (
  select ds.name::text as name, coalesce(ds.decrypted_secret, '') as value
    from vault.decrypted_secrets ds
   where ds.name in ('app_functions_url', 'app_internal_bearer', 'app_service_role_key')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'every push leaves through one function, with a time limit of 10 seconds (send_push_event, P35)',
          case when exists (select 1 from helper where body ~ 'timeout_milliseconds\s*:=\s*10000')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'functions that read the vault or call pg_net themselves',
          (select coalesce(string_agg(name, ', ' order by name collate "C"), 'none') from fn where on_its_own),
          'the eleven before; send_push_event after'),
      (4, 'functions that ask send_push_event for their push',
          (select coalesce(string_agg(name, ', ' order by name collate "C"), 'none') from fn where through_the_helper),
          'none before; the eleven after'),
      (5, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(fn.shown, '; ' order by fn.shown collate "C"), 'none')
             from fn
            where (fn.name = 'send_push_event' and not exists (select 1 from helper where helper.oid = fn.oid))
               or (fn.name in (select split_part(split_part(e.signature, '(', 1), '.', 2) from eleven e)
                   and not exists (select 1 from eleven e where to_regprocedure(e.signature) = fn.oid))),
          'none — otherwise stop and report the line'),
      (6, 'who may execute send_push_event',
          coalesce((select string_agg(r.rolname, ', ' order by r.rolname collate "C")
                      from helper, pg_roles r
                     where r.rolname in ('anon', 'authenticated', 'authenticator', 'postgres', 'service_role')
                       and has_function_privilege(r.oid, helper.oid, 'EXECUTE')),
                   'no such function'),
          'no such function before; postgres, service_role after'),
      (7, 'an endpoint must be an address at a known push service (B3)',
          case when not exists (select 1 from rule) then 'no'
               when (select validated from rule) then 'yes'
               else 'yes, for new and changed rows only (NOT validated)' end,
          'no before; yes after — NOT validated when line 9 is not 0'),
      (8, 'devices registered for notifications',
          (select count(*)::text from public.push_subscriptions),
          'information; the same before and after'),
      (9, 'devices whose endpoint is NOT at a known push service',
          (select case when count(*) = 0 then '0'
                       else sum(devices)::text || ': '
                            || string_agg(host || ' (' || devices || ')', ', ' order by host collate "C") end
             from hosts),
          '0 — otherwise read the runbook page before applying'),
      (10, 'vault: the address of the functions (app_functions_url)',
          case when exists (select 1 from secret where name = 'app_functions_url' and value <> '') then 'set'
               else 'MISSING: no push is sent' end,
          'set'),
      (11, 'vault: the bearer of send-push',
          case
            when exists (select 1 from secret where name = 'app_internal_bearer' and value <> '')
             and exists (select 1 from secret where name = 'app_service_role_key' and value <> '')
              then case when (select value from secret where name = 'app_internal_bearer')
                           = (select value from secret where name = 'app_service_role_key')
                        then 'app_internal_bearer, and app_service_role_key with the same value'
                        else 'app_internal_bearer, and app_service_role_key with ANOTHER value' end
            when exists (select 1 from secret where name = 'app_internal_bearer' and value <> '')
              then 'app_internal_bearer'
            when exists (select 1 from secret where name = 'app_service_role_key' and value <> '')
              then 'app_service_role_key'
            else 'MISSING: no push is sent'
          end,
          'app_service_role_key, until it is renamed; then app_internal_bearer'),
      (12, 'pg_net takes a time limit (net.http_post … timeout_milliseconds)',
          case when exists (select 1 from pg_proc p
                             where p.oid = to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)')
                               and p.proargnames @> array['url', 'body', 'headers', 'timeout_milliseconds'])
               then 'yes' else 'no' end,
          'yes — otherwise stop and report the line')
  ) as t (n, "check", value, expected)
 order by n;
