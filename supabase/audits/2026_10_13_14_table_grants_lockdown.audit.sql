-- Audit for 2026_10_13_14_table_grants_lockdown. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                          before      after
--    1 running as                                                   postgres    postgres
--    2 tables of public                                             20          20
--    3 views and sequences of public                                none        none
--    4 tables, views and sequences not owned by postgres            none        none
--    5 tables without row-level security                            none        none
--    6 tables a request without a session holds a privilege on (L24)
--                                                                   all 20      none
--    7 tables a signed-in user may NOT read, insert into, update and delete from
--                                                                   none        none
--    8 tables a signed-in user may TRUNCATE, or holds REFERENCES, TRIGGER or MAINTAIN on (L24)
--                                                                   all 20      none
--    9 tables PUBLIC holds a privilege on                           none        none
--   10 tables the service role does NOT hold every privilege on     none        none
--   11 columns that carry a privilege of their own                  none        none
--   12 sequences open to a request without a session, or that a signed-in user may read or set
--                                                                   none        none
--   13 a new table of postgres in public gives
--        before   anon: everything; authenticated: everything; postgres: everything; service_role: everything
--        after    authenticated: DELETE, INSERT, SELECT, UPDATE; postgres: everything; service_role: everything
--   14 a new sequence of postgres in public gives
--        before   anon: everything; authenticated: everything; postgres: everything; service_role: everything
--        after    authenticated: USAGE; postgres: everything; service_role: everything
--   15 other roles whose new tables in public are open to a request without a session
--                                                                   supabase_admin   supabase_admin
--
-- Lines 6 and 8 are the finding: they read "none" after. Lines 13 and 14 are
-- what a table or a sequence created later starts with.
-- Line 7 is the one that must read "none" BEFORE AND AFTER: a name that
-- appears there after the migration is a table the app can no longer read or
-- write.
-- Line 4 must read "none" before: the migration refuses to run otherwise,
-- and changes nothing.
-- Line 5 is a table every signed-in user reads and writes in full, before
-- and after: the migration takes the request without a session out of it,
-- and nothing else. It does not stop the migration.
-- Line 15 is information: the platform's own role, which this file cannot and
-- does not change. Nothing of the app is created by it.
--
-- "Tables" in lines 6 and 8 to 10 are tables and views. In lines 6, 8 and 9
-- a privilege on one column counts as one on its table; lines 7 and 10 ask
-- about the whole table. A set is written "none", "all N", or "H of N" —
-- followed by the names when there are twelve or fewer.
-- "everything" is every privilege there is on a table (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) or on a sequence
-- (USAGE, SELECT, UPDATE).
with rel as (
  select c.oid,
         c.relname::text as name,
         c.relkind,
         case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                        when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end as kind,
         pg_get_userbyid(c.relowner)::text as owner,
         c.relrowsecurity as rls,
         coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 'S' else 'r' end::"char", c.relowner)) as acl
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
),
-- What GRANT … ON ALL TABLES reaches: tables and views.
tbl as (
  select * from rel where relkind <> 'S'
),
-- What each of the three API roles can do to each of them, as PostgreSQL
-- answers it: `on_table` for the whole table, `somewhere` when a grant on a
-- single column is enough.
may as (
  select tbl.name, tbl.relkind, w.who, p.privilege,
         has_table_privilege(w.who, tbl.oid, p.privilege) as on_table,
         case when p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              then has_any_column_privilege(w.who, tbl.oid, p.privilege)
              else has_table_privilege(w.who, tbl.oid, p.privilege) end as somewhere
    from tbl
   cross join (values ('anon'), ('authenticated'), ('service_role')) as w (who)
   cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) as p (privilege)
),
-- One row per table and per check: is it in the set the check counts?
member (n, name, hit) as (
            select  5, name, not rls from tbl where relkind in ('r', 'p')
  union all select  6, name, bool_or(somewhere) from may where who = 'anon' group by name
  union all select  7, name, not bool_and(on_table)
              from may
             where who = 'authenticated' and relkind in ('r', 'p')
               and privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             group by name
  union all select  8, name, bool_or(somewhere)
              from may
             where who = 'authenticated'
               and privilege in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
             group by name
  union all select  9, tbl.name,
                   exists (select 1 from aclexplode(tbl.acl) a where a.grantee = 0)
                   or exists (select 1
                                from pg_attribute att
                               cross join lateral aclexplode(att.attacl) a
                               where att.attrelid = tbl.oid and a.grantee = 0)
              from tbl
  union all select 10, name, not bool_and(on_table) from may where who = 'service_role' group by name
),
tally as (
  select n,
         case
           when count(*) filter (where hit) = 0 then 'none'
           else case when count(*) filter (where hit) = count(*) then 'all ' || count(*)
                     else count(*) filter (where hit) || ' of ' || count(*) end
                || case when count(*) filter (where hit) <= 12
                        then ': ' || string_agg(name, '; ' order by name collate "C") filter (where hit)
                        else '' end
         end as value
    from member
   group by n
),
-- What a table ('r') or a sequence ('S') that `postgres` creates in public
-- starts with: PostgreSQL's built-in default (or the global entry that
-- replaces it), plus what the entry for the schema adds.
starts_with as (
  select o.kind,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee,
         a.privilege_type as privilege
    from (values ('r'::"char"), ('S'::"char")) as o (kind)
   cross join lateral (
     select x.grantee, x.privilege_type
       from aclexplode(coalesce(
              (select d.defaclacl from pg_default_acl d
                where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = o.kind),
              acldefault(o.kind, 'postgres'::regrole))) x
     union
     select x.grantee, x.privilege_type
       from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) x
      where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
        and d.defaclobjtype = o.kind
   ) a
),
gives as (
  select kind,
         string_agg(grantee || ': ' || held, '; ' order by grantee collate "C") as value
    from (
      select s.kind, s.grantee,
             case when count(*) = (case s.kind when 'r' then 8 else 3 end) then 'everything'
                  else string_agg(s.privilege, ', ' order by s.privilege collate "C") end as held
        from starts_with s
       group by s.kind, s.grantee
    ) per_role
   group by kind
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'tables of public',
          (select count(*)::text from rel where relkind in ('r', 'p')),
          '20'),
      (3, 'views and sequences of public',
          (select coalesce(string_agg(name || ' (' || kind || ')', '; ' order by name collate "C"), 'none')
             from rel where relkind not in ('r', 'p')),
          'none'),
      (4, 'tables, views and sequences not owned by postgres',
          (select coalesce(string_agg(name || ' (' || owner || ')', '; ' order by name collate "C"), 'none')
             from rel where owner <> 'postgres'),
          'none — otherwise the migration refuses to run'),
      (5, 'tables without row-level security',
          coalesce((select value from tally where n = 5), 'none'),
          'none — a name here is a table every signed-in user reads and writes in full'),
      (6, 'tables a request without a session holds a privilege on (L24)',
          coalesce((select value from tally where n = 6), 'none'),
          'all 20 before, none after'),
      (7, 'tables a signed-in user may NOT read, insert into, update and delete from',
          coalesce((select value from tally where n = 7), 'none'),
          'none, before and after'),
      (8, 'tables a signed-in user may TRUNCATE, or holds REFERENCES, TRIGGER or MAINTAIN on (L24)',
          coalesce((select value from tally where n = 8), 'none'),
          'all 20 before, none after'),
      (9, 'tables PUBLIC holds a privilege on',
          coalesce((select value from tally where n = 9), 'none'),
          'none, before and after'),
      (10, 'tables the service role does NOT hold every privilege on',
          coalesce((select value from tally where n = 10), 'none'),
          'none, before and after'),
      (11, 'columns that carry a privilege of their own',
          (select coalesce(string_agg(rel.name || '.' || att.attname, '; ' order by rel.name collate "C", att.attnum), 'none')
             from rel
             join pg_attribute att on att.attrelid = rel.oid
            where att.attacl is not null and not att.attisdropped),
          'none, before and after'),
      (12, 'sequences open to a request without a session, or that a signed-in user may read or set',
          (select coalesce(string_agg(rel.name, '; ' order by rel.name collate "C"), 'none')
             from rel
            where rel.relkind = 'S'
              and (has_sequence_privilege('anon', rel.oid, 'USAGE')
                   or has_sequence_privilege('anon', rel.oid, 'SELECT')
                   or has_sequence_privilege('anon', rel.oid, 'UPDATE')
                   or has_sequence_privilege('authenticated', rel.oid, 'SELECT')
                   or has_sequence_privilege('authenticated', rel.oid, 'UPDATE'))),
          'none, before and after: public holds no sequence'),
      (13, 'a new table of postgres in public gives',
          coalesce((select value from gives where kind = 'r'), 'nobody anything'),
          'everything to anon, authenticated, postgres and service_role before; '
          || 'authenticated: DELETE, INSERT, SELECT, UPDATE; postgres: everything; service_role: everything after'),
      (14, 'a new sequence of postgres in public gives',
          coalesce((select value from gives where kind = 'S'), 'nobody anything'),
          'everything to anon, authenticated, postgres and service_role before; '
          || 'authenticated: USAGE; postgres: everything; service_role: everything after'),
      (15, 'other roles whose new tables in public are open to a request without a session',
          (select coalesce(string_agg(role, ', ' order by role collate "C"), 'none')
             from (select distinct pg_get_userbyid(d.defaclrole)::text as role
                     from pg_default_acl d
                    cross join lateral aclexplode(d.defaclacl) a
                    where d.defaclobjtype = 'r'
                      and d.defaclnamespace = 'public'::regnamespace
                      and d.defaclrole <> 'postgres'::regrole
                      and (a.grantee = 0 or pg_get_userbyid(a.grantee) = 'anon')) r),
          'supabase_admin (the platform''s role: information, not changed)')
  ) as line (n, "check", value, expected)
 order by n;
