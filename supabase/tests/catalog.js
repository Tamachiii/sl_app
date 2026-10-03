// What a database IS, as plain data: every object user SQL can create or
// change, read from the system catalogs. Two databases built in different ways
// (schema.sql; the production baseline plus the migrations) have the same
// catalog exactly when their snapshots are equal.
//
//   const snapshot = await catalogSnapshot(q);     // q: asAdmin's, or db.query
//   expect(diffCatalogs(a, b, { left: 'migrated', right: 'schema.sql' })).toEqual([]);
//
// A snapshot is `{ section: { key: fields } }`. Sections:
//
//   schemas        owner, privileges
//   tables         tables, views and sequences: kind, owner, RLS on/forced,
//                  replica identity, storage options, view text, privileges
//   columns        type, NOT NULL, default, identity/generated, privileges
//   constraints    definition (keys, checks, foreign keys), validated or not
//   indexes        definition, valid or not
//   triggers       definition, enabled state
//   policies       command, permissive, roles, USING and WITH CHECK
//   functions      full definition (signature, language, volatility, SECURITY
//                  DEFINER, SET clauses, body), owner, privileges
//   types          enum labels in order; domains
//   sequences      type and bounds, owning column
//   defaultPrivileges   ALTER DEFAULT PRIVILEGES entries
//   publications   operations and member tables
//   extensions     schema, version
//   comments       COMMENT ON text
//   rules          rewrite rules other than a view's own
//   data           the rows SQL files insert (REFERENCE_DATA below), and the
//                  row count of every table of the application schemas
//
// In scope: every schema except pg_catalog, information_schema and the toast
// and temp schemas — so a policy on storage.objects or a trigger on auth.users
// counts. Out of scope: anything cluster-wide (roles, role settings), which
// the databases of one test run share anyway; column ORDER (a migration adds a
// column at the end, schema.sql may declare it anywhere); object ids.
//
// Text produced by pg_get_*def() qualifies a name or not depending on
// search_path, so both snapshots must be taken with the same one. `postgres`
// has a role default, and catalogSnapshot() refuses any other.

const SEARCH_PATH = '"$user", public, extensions';

/** Schemas whose tables hold application rows (their row counts are compared). */
const APPLICATION_SCHEMAS = ['public', 'app_private'];

/**
 * Tables whose CONTENT comes from the SQL files, not from the app: compared
 * row by row. Add a table here when a migration seeds one — parity.test.js
 * refuses rows in an application table that is not listed, since all it could
 * compare is how many there are. `columns` leaves out what differs between
 * two loads (timestamps, generated ids).
 */
export const REFERENCE_DATA = [
  { table: 'storage.buckets', columns: ['id', 'name', 'public', 'file_size_limit', 'allowed_mime_types'] },
  { table: 'app_private.app_migrations', columns: ['name'] },
];

const inScope = (ns) => `${ns}.nspname not in ('pg_catalog', 'information_schema') and ${ns}.nspname !~ '^pg_(toast|temp)'`;

// An aclitem[] as sorted lines "grantee: PRIVILEGE, PRIVILEGE*" (* = with
// grant option). A NULL acl means "the built-in default for this kind of
// object", which acldefault() spells out so that NULL and its expansion
// compare equal; columns and default-privilege entries have no such default
// (a NULL there is no privilege at all, and aclexplode(NULL) is no row).
const privileges = (aclItems) => `(
  select coalesce(array_agg(entry order by entry), '{}')
    from (
      select case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end
             || ': '
             || string_agg(x.privilege_type || case when x.is_grantable then '*' else '' end, ', '
                           order by x.privilege_type) as entry
        from aclexplode(${aclItems}) x
       group by x.grantee
    ) entries
)`;
const withDefault = (acl, kind, owner) => `coalesce(${acl}, acldefault(${kind}, ${owner}))`;

const SECTIONS = {
  schemas: `
    select n.nspname as key,
           pg_get_userbyid(n.nspowner) as owner,
           ${privileges(withDefault('n.nspacl', "'n'", 'n.nspowner'))} as privileges
      from pg_namespace n
     where ${inScope('n')}`,

  tables: `
    select n.nspname || '.' || c.relname as key,
           case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view'
                          when 'm' then 'materialized view' when 'f' then 'foreign table'
                          when 'S' then 'sequence' end as kind,
           pg_get_userbyid(c.relowner) as owner,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as rls_forced,
           case c.relreplident when 'd' then 'default' when 'n' then 'nothing'
                               when 'f' then 'full' when 'i' then 'index' end as replica_identity,
           c.reloptions as options,
           case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as view,
           ${privileges(withDefault('c.relacl', `case when c.relkind = 'S' then 'S' else 'r' end::"char"`, 'c.relowner'))} as privileges
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where ${inScope('n')} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`,

  columns: `
    select n.nspname || '.' || c.relname || '.' || a.attname as key,
           format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null,
           pg_get_expr(d.adbin, d.adrelid) as "default",
           nullif(a.attidentity, '') as identity,
           nullif(a.attgenerated, '') as generated,
           (select l.collname from pg_collation l
             where l.oid = a.attcollation and l.collname <> 'default') as collation,
           ${privileges('a.attacl')} as privileges
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where ${inScope('n')} and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and a.attnum > 0 and not a.attisdropped`,

  constraints: `
    select n.nspname || '.' || coalesce(c.relname, t.typname) || '.' || o.conname as key,
           case o.contype when 'c' then 'check' when 'f' then 'foreign key' when 'p' then 'primary key'
                          when 'u' then 'unique' when 'x' then 'exclusion' when 't' then 'constraint trigger'
                          else o.contype::text end as kind,
           pg_get_constraintdef(o.oid, true) as definition,
           o.convalidated as validated
      from pg_constraint o
      join pg_namespace n on n.oid = o.connamespace
      left join pg_class c on c.oid = o.conrelid
      left join pg_type t on t.oid = o.contypid
     where ${inScope('n')}`,

  indexes: `
    select n.nspname || '.' || i.relname as key,
           pg_get_indexdef(x.indexrelid) as definition,
           x.indisvalid as valid
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_namespace n on n.oid = i.relnamespace
     where ${inScope('n')}`,

  triggers: `
    select n.nspname || '.' || c.relname || '.' || t.tgname as key,
           pg_get_triggerdef(t.oid, true) as definition,
           case t.tgenabled when 'O' then 'enabled' when 'D' then 'disabled'
                            when 'R' then 'replica only' when 'A' then 'always' end as state
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where ${inScope('n')} and not t.tgisinternal`,

  policies: `
    select n.nspname || '.' || c.relname || '.' || p.polname as key,
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' when '*' then 'ALL' end as command,
           p.polpermissive as permissive,
           (select coalesce(array_agg(r.name order by r.name), '{}')
              from (select case when u.id = 0 then 'PUBLIC' else pg_get_userbyid(u.id)::text end as name
                      from unnest(p.polroles) as u(id)) r) as roles,
           pg_get_expr(p.polqual, p.polrelid, true) as using,
           pg_get_expr(p.polwithcheck, p.polrelid, true) as with_check
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where ${inScope('n')}`,

  // Functions an extension brought are the extension's business (and are
  // covered by its name and version below).
  functions: `
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
           case p.prokind when 'f' then 'function' when 'p' then 'procedure'
                          when 'a' then 'aggregate' when 'w' then 'window' end as kind,
           pg_get_userbyid(p.proowner) as owner,
           case when p.prokind <> 'a' then pg_get_functiondef(p.oid) end as definition,
           ${privileges(withDefault('p.proacl', "'f'", 'p.proowner'))} as privileges
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where ${inScope('n')}
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )`,

  types: `
    select n.nspname || '.' || t.typname as key,
           case t.typtype when 'e' then 'enum' when 'd' then 'domain' end as kind,
           pg_get_userbyid(t.typowner) as owner,
           (select array_agg(e.enumlabel::text order by e.enumsortorder)
              from pg_enum e where e.enumtypid = t.oid) as labels,
           case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end as base,
           case when t.typtype = 'd' then t.typnotnull end as not_null,
           case when t.typtype = 'd' then t.typdefault end as "default",
           ${privileges(withDefault('t.typacl', "'T'", 't.typowner'))} as privileges
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where ${inScope('n')} and t.typtype in ('e', 'd')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e'
       )`,

  sequences: `
    select n.nspname || '.' || c.relname as key,
           format_type(s.seqtypid, null) as type,
           s.seqstart::text as start,
           s.seqincrement::text as increment,
           s.seqmin::text as min,
           s.seqmax::text as max,
           s.seqcycle as cycle,
           (select o.refobjid::regclass::text || '.' || a.attname
              from pg_depend o
              join pg_attribute a on a.attrelid = o.refobjid and a.attnum = o.refobjsubid
             where o.classid = 'pg_class'::regclass and o.objid = c.oid
               and o.refclassid = 'pg_class'::regclass and o.deptype in ('a', 'i')
             limit 1) as owned_by
      from pg_sequence s
      join pg_class c on c.oid = s.seqrelid
      join pg_namespace n on n.oid = c.relnamespace
     where ${inScope('n')}`,

  defaultPrivileges: `
    select 'objects created by ' || pg_get_userbyid(d.defaclrole)
           || case when d.defaclnamespace = 0 then ' in any schema' else ' in schema ' || n.nspname end
           || ': '
           || case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                                   when 'T' then 'types' when 'n' then 'schemas' else d.defaclobjtype::text end as key,
           ${privileges('d.defaclacl')} as privileges
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace`,

  publications: `
    select p.pubname as key,
           pg_get_userbyid(p.pubowner) as owner,
           p.puballtables as all_tables,
           p.pubinsert as "insert", p.pubupdate as "update", p.pubdelete as "delete", p.pubtruncate as "truncate",
           (select coalesce(array_agg(t.schemaname || '.' || t.tablename order by t.schemaname, t.tablename), '{}')
              from pg_publication_tables t where t.pubname = p.pubname) as tables
      from pg_publication p`,

  extensions: `
    select e.extname as key, n.nspname as schema, e.extversion as version
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace`,

  // 16384 = the first object id a database hands out: skips the comments that
  // ship with PostgreSQL itself.
  comments: `
    select o.type || ' ' || o.identity as key, d.description as text
      from pg_description d
     cross join lateral pg_identify_object(d.classoid, d.objoid, d.objsubid) o
     where d.objoid >= 16384`,

  rules: `
    select r.schemaname || '.' || r.tablename || '.' || r.rulename as key, r.definition
      from pg_rules r
     where r.schemaname not in ('pg_catalog', 'information_schema')`,
};

async function dataSection(q) {
  const out = {};

  const present = await q.rows(
    `select name, to_regclass(name) is not null as present from unnest($1::text[]) as name`,
    [REFERENCE_DATA.map((d) => d.table)],
  );
  for (const { table, columns } of REFERENCE_DATA) {
    // A table that is not there (yet) is `null`, not an error: the snapshot
    // of a database before the migration that creates it must still work.
    out[`rows of ${table}`] = present.find((row) => row.name === table).present
      ? {
        rows: (await q.rows(
          `select to_jsonb(t) as row from (select ${columns.join(', ')} from ${table}) t order by 1`,
        )).map((r) => JSON.stringify(r.row)),
      }
      : { rows: null };
  }

  const reference = new Set(REFERENCE_DATA.map((d) => d.table));
  const tables = (await q.rows(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p')
      order by 1, 2`,
    [APPLICATION_SCHEMAS],
  )).filter(({ schema, name }) => !reference.has(`${schema}.${name}`));
  if (tables.length) {
    // One round trip for all of them.
    const counts = await q.rows(tables.map(({ schema, name }) => (
      `select '${schema}.${name}' as name, count(*) as count from "${schema}"."${name}"`
    )).join('\nunion all\n'));
    for (const { name, count } of counts) out[`row count of ${name}`] = { count };
  }
  return out;
}

/**
 * Read the catalog through `q` — a harness query function running as
 * `postgres`: the `q` of asAdmin()/scenario(), or `db.query` of a
 * scratchDatabase().
 */
export async function catalogSnapshot(q) {
  const searchPath = await q.value(`select current_setting('search_path')`);
  if (searchPath !== SEARCH_PATH) {
    throw new Error(
      `catalogSnapshot: search_path is ${JSON.stringify(searchPath)}, expected ${JSON.stringify(SEARCH_PATH)} `
      + '(read the catalog as `postgres`: asAdmin(), scenario() or a scratchDatabase())',
    );
  }

  // Together: a pool spreads them over its connections, a harness `q` (one
  // connection inside a transaction) queues them.
  const sections = Object.entries(SECTIONS);
  const [data, ...results] = await Promise.all([
    dataSection(q),
    ...sections.map(([, sql]) => q.rows(`${sql}\n order by 1`)),
  ]);

  const snapshot = {};
  sections.forEach(([section], index) => {
    snapshot[section] = {};
    for (const { key, ...fields } of results[index]) {
      if (key in snapshot[section]) throw new Error(`catalogSnapshot: two ${section} named ${key}`);
      snapshot[section][key] = fields;
    }
  });
  snapshot.data = data;
  return snapshot;
}

/** The names of the sections of a snapshot, in order. */
export const CATALOG_SECTIONS = [...Object.keys(SECTIONS), 'data'];

// ------------------------------------------------------------
// Comparing two snapshots
// ------------------------------------------------------------

const show = (value) => (value === undefined ? 'nothing' : JSON.stringify(value));

// A list (privileges, roles, enum labels): the entries one side has and the
// other has not. A long text (a function, a view): the first line that
// differs, which is what the reader has to go and look at.
function describeChange(field, a, b, left, right) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const onlyA = a.filter((item) => !b.includes(item));
    const onlyB = b.filter((item) => !a.includes(item));
    if (onlyA.length || onlyB.length) {
      return `${field}: ${[
        onlyA.length ? `${show(onlyA)} only in ${left}` : null,
        onlyB.length ? `${show(onlyB)} only in ${right}` : null,
      ].filter(Boolean).join('; ')}`;
    }
  }
  const multiline = [a, b].some((v) => typeof v === 'string' && v.includes('\n'));
  if (!multiline) return `${field}: ${show(a)} (${left}) ≠ ${show(b)} (${right})`;
  const linesA = String(a ?? '').split('\n');
  const linesB = String(b ?? '').split('\n');
  let n = 0;
  while (n < linesA.length && n < linesB.length && linesA[n] === linesB[n]) n += 1;
  return `${field}: first difference at line ${n + 1} — `
    + `${show(linesA[n]?.trim())} (${left}) ≠ ${show(linesB[n]?.trim())} (${right})`;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The differences between two snapshots, one line each — `[]` when they
 * describe the same database. `left` and `right` name the two sides in the
 * messages.
 *
 *   functions public.adopt_skip(p_slot_id uuid, p_dry_run boolean): only in schema.sql
 *   columns public.set_logs.rpe: type: "integer" (migrated) ≠ "numeric(3,1)" (schema.sql)
 */
export function diffCatalogs(a, b, { left = 'left', right = 'right' } = {}) {
  const out = [];
  for (const section of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const inA = a[section] ?? {};
    const inB = b[section] ?? {};
    for (const key of [...new Set([...Object.keys(inA), ...Object.keys(inB)])].sort()) {
      if (!(key in inB)) out.push(`${section} ${key}: only in ${left}`);
      else if (!(key in inA)) out.push(`${section} ${key}: only in ${right}`);
      else {
        for (const field of new Set([...Object.keys(inA[key]), ...Object.keys(inB[key])])) {
          if (!same(inA[key][field], inB[key][field])) {
            out.push(`${section} ${key}: ${describeChange(field, inA[key][field], inB[key][field], left, right)}`);
          }
        }
      }
    }
  }
  return out;
}
