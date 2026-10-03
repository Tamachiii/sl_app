// The rules a migration follows (supabase/migrations/README.md), as code.
//
//   staticProblems(migration)        what can be read off the three files
//   checkMigration(db, migration)    what only running them shows: refused
//                                    without its predecessor, applied, refused
//                                    twice, rolled back, applied again
//   withoutOptionalProblems(db, migrations)
//                                    the whole list, applied with the optional
//                                    ones left out
//
// Each returns a list of sentences, `[]` when everything is in order, so the
// same code judges the real files (migration-conventions.test.js) and the
// deliberately wrong ones that test the judge itself.
//
// `migration` is `{ name, kind, predecessor, reversible, up, down, audit }`:
// `predecessor` is the NAME the file must require (null for the first), and
// `up` / `down` / `audit` are the SQL text of the three files.

import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { splitStatements } from './sql.js';
import { LEDGER, REFUSAL } from '../migrations/manifest.js';

const TRANSACTION_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;
const BEGIN = /^(begin|start\s+transaction)$/i;
const COMMIT = /^commit$/i;
const LOCK_TIMEOUT = /^set\s+local\s+lock_timeout\s*(=|\s+to\s)\s*'\d+\s*(ms|s)'$/i;
const NOTIFY = /^notify\s+pgrst\s*,\s*'reload schema'$/i;
const READ = /^(select|with|values|table)\b/i;
const LEDGER_INSERT = new RegExp(`^insert\\s+into\\s+${LEDGER.replace('.', '\\.')}\\b`, 'i');

// One transaction around everything: BEGIN, the lock timeout, …, COMMIT.
function transactionProblems(statements, file) {
  const out = [];
  const [first, second] = statements;
  const last = statements.at(-1);
  if (!first || !BEGIN.test(first.text)) out.push(`${file}: the first statement is not BEGIN`);
  if (!second || !LOCK_TIMEOUT.test(second.text)) {
    out.push(`${file}: the second statement is not SET LOCAL lock_timeout = '…s'`);
  }
  if (!last || !COMMIT.test(last.text)) out.push(`${file}: the last statement is not COMMIT`);
  for (const statement of statements.slice(1, -1)) {
    if (TRANSACTION_CONTROL.test(statement.text)) {
      out.push(`${file}:${statement.line}: ${statement.text.split(/\s/)[0].toUpperCase()} inside the file — one transaction, opened on the first line and committed on the last`);
    }
  }
  return out;
}

// The third statement: a DO block that refuses before anything is touched.
function guardProblems(statements, file, expected) {
  const guard = statements[2];
  if (!guard || !/^do\b/i.test(guard.text)) {
    return [`${file}: the third statement is not the guard (a DO block that raises before anything is changed)`];
  }
  return expected
    .filter(({ needs }) => needs.some((text) => !guard.text.includes(text)))
    .map(({ what }) => `${file}:${guard.line}: the guard does not ${what}`);
}

/** What the text of the three files gets wrong — `[]` when nothing. */
export function staticProblems({ name, predecessor, up, down, audit }) {
  const out = [];

  const upStatements = splitStatements(up);
  out.push(...transactionProblems(upStatements, 'migration'));
  out.push(...guardProblems(upStatements, 'migration', [
    { what: `refuse a second run (it must name ${name} and raise ${REFUSAL.alreadyApplied})`, needs: [name, REFUSAL.alreadyApplied] },
    ...(predecessor ? [{
      what: `require ${predecessor} (it must name it and raise ${REFUSAL.predecessorMissing})`,
      needs: [predecessor, REFUSAL.predecessorMissing],
    }] : []),
  ]));
  if (!upStatements.some((s) => LEDGER_INSERT.test(s.text) && s.text.includes(`'${name}'`))) {
    out.push(`migration: no INSERT INTO ${LEDGER} of '${name}'`);
  }

  const downStatements = splitStatements(down);
  out.push(...transactionProblems(downStatements, 'rollback'));
  out.push(...guardProblems(downStatements, 'rollback', [
    { what: `refuse when the migration is not applied (it must name ${name} and raise ${REFUSAL.notApplied})`, needs: [name, REFUSAL.notApplied] },
  ]));

  const auditStatements = splitStatements(audit);
  if (auditStatements.length !== 1) {
    out.push(
      `audit: ${auditStatements.length} statements — an audit is ONE query returning ONE table `
      + '(the SQL editor and `supabase db query` only show the result of the last statement)',
    );
  } else if (!READ.test(auditStatements[0].text)) {
    out.push('audit: it does not start with SELECT, WITH, VALUES or TABLE');
  }
  return out;
}

// What PostgREST keeps in its schema cache: the tables, columns, keys and
// function signatures of `public`. The foreign keys say what can be embedded
// in what (`select=*,program:programs(*)`); the primary and unique keys say
// whether that is one row or a list, and what an upsert conflicts on. A
// function body is not in it, nor a check constraint, a policy or an index.
const KEYS = ['foreign key', 'primary key', 'unique'];
function apiSurface(snapshot) {
  const out = {};
  const inPublic = (section) => Object.entries(snapshot[section]).filter(([key]) => key.startsWith('public.'));
  for (const [key, table] of inPublic('tables')) out[`table ${key}`] = table.kind;
  for (const [key, column] of inPublic('columns')) out[`column ${key}`] = column.type;
  for (const [key, fn] of inPublic('functions')) {
    out[`function ${key}`] = String(fn.definition).split(/\nAS /)[0];
  }
  for (const [key, constraint] of inPublic('constraints')) {
    if (KEYS.includes(constraint.kind)) out[`${constraint.kind} ${key}`] = constraint.definition;
  }
  return out;
}

// The first few things of the API surface that differ between two snapshots,
// as text — null when PostgREST would see no difference.
function surfaceChange(from, to) {
  const [a, b] = [apiSurface(from), apiSurface(to)];
  const moved = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]);
  return moved.length ? `${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ', …' : ''}` : null;
}

const notifies = (sql) => splitStatements(sql).some((s) => NOTIFY.test(s.text));

const refusedWith = (error, code) => error?.code === code;
const told = (error) => `${error.code ?? 'no SQLSTATE'}: ${error.message.split('\n')[0]}`;

/**
 * Run the migration through its whole life on `db` — a scratchDatabase() that
 * holds everything the migration builds on — and report what does not hold.
 * The migration is left APPLIED, so the next one of the manifest can follow.
 */
export async function checkMigration(db, { name, predecessor, reversible, up, down, audit }) {
  const out = [];
  const attempt = async (sql, label) => {
    try {
      await db.runSql(sql, label);
      return null;
    } catch (error) {
      return error;
    }
  };
  const snapshot = () => catalogSnapshot(db.query);
  const unchanged = async (reference, when) => {
    const diff = diffCatalogs(reference, await snapshot(), { left: 'before', right: 'after' });
    if (diff.length) out.push(`${when}, and yet the database changed:\n  ${diff.join('\n  ')}`);
  };
  const inLedger = async () => await db.query.value(`select to_regclass($1) is not null`, [LEDGER])
    && await db.query.value(`select exists (select 1 from ${LEDGER} where name = $1)`, [name]);
  const runAudit = async (when) => {
    try {
      const [result] = await db.readOnly(audit, 'audit');
      if (!result?.fields?.length) out.push(`audit (${when}): it returns no table`);
    } catch (error) {
      out.push(
        error.code === '25006'
          ? `audit (${when}): it writes — ${error.message.split('\n')[0]}`
          : `audit (${when}): it fails — ${told(error)}`,
      );
    }
  };

  const before = await snapshot();
  await runAudit('before the migration');

  // Without the migration it builds on, it refuses and touches nothing.
  let applied = false;
  if (predecessor) {
    const row = await db.query.one(`delete from ${LEDGER} where name = $1 returning name, applied_at`, [predecessor]);
    if (!row) return [...out, `${predecessor}, which it builds on, is not applied in this database`];
    const error = await attempt(up, 'migration');
    await db.query(`insert into ${LEDGER} (name, applied_at) values ($1, $2)`, [row.name, row.applied_at]);
    if (!error) {
      out.push(`it runs although ${predecessor} is not in the ledger`);
      applied = true;
    } else if (!refusedWith(error, REFUSAL.predecessorMissing)) {
      out.push(`without ${predecessor} in the ledger it fails with ${told(error)} — expected a refusal with ${REFUSAL.predecessorMissing}`);
    } else {
      await unchanged(before, `it refused to run without ${predecessor}`);
    }
  }

  // Up.
  if (!applied) {
    const error = await attempt(up, 'migration');
    if (error) return [...out, `it does not apply — ${error.message}`];
  }
  const after = await snapshot();
  if (!(await inLedger())) out.push(`applied, it is not in ${LEDGER}`);

  const exposed = surfaceChange(before, after);
  if (exposed && !notifies(up)) {
    out.push(`it changes what the API exposes (${exposed}) without NOTIFY pgrst, 'reload schema'`);
  }

  // Up again: refused, nothing touched.
  const again = await attempt(up, 'migration');
  if (!again) out.push('a second run goes through — it must refuse');
  else if (!refusedWith(again, REFUSAL.alreadyApplied)) {
    out.push(`a second run fails with ${told(again)} — expected a refusal with ${REFUSAL.alreadyApplied}`);
  }
  await unchanged(after, 'a second run was attempted');
  await runAudit('after the migration');

  // Down: the ledger row goes, and so does everything the migration made.
  const undo = await attempt(down, 'rollback');
  if (undo) return [...out, `the rollback fails — ${undo.message}`];
  if (await inLedger()) out.push(`rolled back, it is still in ${LEDGER}`);
  const rolledBack = await snapshot();
  if (reversible) {
    const diff = diffCatalogs(before, rolledBack, { left: 'before the migration', right: 'after its rollback' });
    if (diff.length) out.push(`the rollback does not give back the database it started from:\n  ${diff.join('\n  ')}`);
  }
  // PostgREST has to forget what the migration made it learn.
  const withdrawn = surfaceChange(after, rolledBack);
  if (withdrawn && !notifies(down)) {
    out.push(`its rollback changes what the API exposes (${withdrawn}) without NOTIFY pgrst, 'reload schema'`);
  }

  // Down again: refused, nothing touched.
  const undoAgain = await attempt(down, 'rollback');
  if (!undoAgain) out.push('the rollback runs a second time — it must refuse when the migration is not applied');
  else if (!refusedWith(undoAgain, REFUSAL.notApplied)) {
    out.push(`a second rollback fails with ${told(undoAgain)} — expected a refusal with ${REFUSAL.notApplied}`);
  }
  await unchanged(rolledBack, 'a second rollback was attempted');

  // Up again: the same database as the first time.
  const reapply = await attempt(up, 'migration');
  if (reapply) return [...out, `after its rollback it does not apply again — ${reapply.message}`];
  const diff = diffCatalogs(after, await snapshot(), { left: 'first run', right: 'run after a rollback' });
  if (diff.length) out.push(`applied again after its rollback, it gives another database:\n  ${diff.join('\n  ')}`);

  return out;
}

/**
 * Apply `migrations` (`[{ name, kind, up }]`, in manifest order) on `db` with
 * the optional ones left out — production as it is when its owner skipped
 * them. A migration that uses something an optional one made fails here and
 * nowhere else: checkMigration() always runs on a database where everything
 * before it is applied, and the guard only knows the NAME a file requires.
 */
export async function withoutOptionalProblems(db, migrations) {
  const skipped = [];
  for (const { name, kind, up } of migrations) {
    if (kind === 'optional') {
      skipped.push(name);
      continue;
    }
    try {
      await db.runSql(up, 'migration');
    } catch (error) {
      // Every migration after this one would only be refused for want of it.
      return [
        `${name}: ${skipped.length ? `without the optional ${skipped.join(', ')} ` : ''}it does not apply — ${error.message}`,
      ];
    }
  }
  return [];
}
