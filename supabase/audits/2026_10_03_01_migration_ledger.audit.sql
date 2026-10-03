-- Audit for 2026_10_03_01_migration_ledger. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--   check                                    before      after
--   running as                               postgres    postgres
--   schema app_private exists                false       true
--   table app_private.app_migrations exists  false       true
--   API roles that can use app_private       none        none
--
-- "true" on the second or third line BEFORE applying means the migration is
-- already there (running it again is refused and changes nothing). Any role
-- named on the last line is a privilege to revoke before going on.
select "check", value, expected
  from (values
    (1, 'running as',
        current_user::text,
        'postgres'),
    (2, 'schema app_private exists',
        (to_regnamespace('app_private') is not null)::text,
        'false before, true after'),
    (3, 'table app_private.app_migrations exists',
        (to_regclass('app_private.app_migrations') is not null)::text,
        'false before, true after'),
    (4, 'API roles that can use app_private',
        coalesce((
          select string_agg(r.rolname, ', ' order by r.rolname)
            from pg_roles r
           where r.rolname in ('anon', 'authenticated', 'service_role')
             and has_schema_privilege(r.oid, to_regnamespace('app_private')::oid, 'USAGE')
        ), 'none'),
        'none')
  ) as t(n, "check", value, expected)
 order by n;
