#!/usr/bin/env node
// Does production have the migrations this commit needs?
//
//   node scripts/check-migrations.mjs --print
//   node --env-file=.env scripts/check-migrations.mjs --verify
//
// --print connects to nothing: it lists supabase/migrations/manifest.json and
// the read-only query that shows what production has.
//
// --verify reads production's ledger (app_private.app_migrations) in one
// read-only transaction and exits 1 naming every `required` migration of the
// manifest that is not in it. It is the step .github/workflows/deploy.yml
// runs between the tests and the publish; the owner runs the same command
// before pushing to `main`. The rules — what stops a deploy, and the one
// thing ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK lifts — are in lib/ledger-gate.mjs;
// what to do when it says no, in docs/runbook/40-deploy.md.
//
// The connection is the backup's (backup/lib/connection.mjs): the same
// variables, the same TLS rules, and nothing printed that holds the password.

import { parseArgs } from 'node:util';
import { loadManifest } from '../supabase/migrations/manifest.js';
import { describeError, say, warn } from './backup/lib/cli.mjs';
import { clientConfig, resolveSource, tlsFor } from './backup/lib/connection.mjs';
import { BackupError } from './backup/lib/errors.mjs';
import { registerSecret } from './backup/lib/secrets.mjs';
import {
  decide, describeManifest, LOCAL_SECRET, manifestFaults, OVERRIDE, PAGE, readLedger, render, SECRET,
} from './lib/ledger-gate.mjs';

const usage = `Usage: node scripts/check-migrations.mjs --print
       node --env-file=.env scripts/check-migrations.mjs --verify

  --print     list the migrations of this commit (supabase/migrations/manifest.json)
              and the read-only query that shows what production has. Connects to
              nothing.
  --verify    read the ledger of production and compare: exit 1 when a \`required\`
              migration is not applied, or when the ledger could not be read.
              \`optional\` and \`contract\` migrations are not asked for.
  -h, --help  this text

Environment (--verify)
  ${SECRET.padEnd(34)} the session-pooler connection string of the project —
  ${''.padEnd(34)} the repository secret of the deploy and of the nightly backup
  ${LOCAL_SECRET.padEnd(34)} or: the database password; the address is read from
  ${''.padEnd(34)} supabase/.temp/pooler-url (written by \`supabase link\`)
  ${OVERRIDE.padEnd(34)} \`true\`: with NO secret set, exit 0 without checking.
  ${''.padEnd(34)} It never lifts a migration that was found missing.
  PGSSLROOTCERT                      optional: the CA file of the project, to check the
  ${''.padEnd(34)} server's certificate

Exit code
  0  every required migration is applied (or: not checked, by the variable above)
  1  the deploy must not go on
  2  the command line is wrong

What to do when it says no: ${PAGE}`;

/** Exit code for "the command line is wrong" — as the backup commands have it. */
const USAGE = 2;

// The gate must end, whatever the network does: it holds up a deploy.
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Connect with what `env` holds, read the ledger, disconnect. Says where it
 * connects before it does: when that fails, the line above the error is the
 * address that was tried.
 */
async function readProduction(env) {
  // A secret that is blank is one that is not set (lib/ledger-gate.mjs).
  const given = { ...env, [SECRET]: env[SECRET]?.trim() || undefined, [LOCAL_SECRET]: env[LOCAL_SECRET]?.trim() || undefined };
  const connection = resolveSource(given);
  // The user, not only the host: through the pooler it is `postgres.<ref>`,
  // the one thing here that says WHICH project is being read.
  say(`  source     ${connection.user} at ${connection.host} (${connection.from}), ${tlsFor(connection, env).says}`);

  const { default: pg } = await import('pg');
  const client = new pg.Client({
    ...clientConfig(connection, env),
    application_name: 'sl_app-deploy-gate',
    query_timeout: QUERY_TIMEOUT_MS,
  });
  // An error on an idle connection is reported by the query that meets it.
  client.on('error', () => {});
  await client.connect();
  try {
    // No parameters: the simple protocol, which every pooler mode passes on.
    const state = await readLedger((sql) => client.query(sql));
    say(`  server     PostgreSQL ${state.serverVersion}, database ${state.database}, role ${state.role}`);
    say('  read       one read-only transaction, rolled back');
    return state;
  } finally {
    await client.end().catch(() => {});
  }
}

/** A failed connection, in the words of the person who has to fix the secret. */
const explain = (error) => (error instanceof BackupError ? error.message : describeError(error));

// In a workflow command, `%` and line breaks are escaped; a message is one line.
const annotation = ({ level, title, text }) => (
  `::${level} title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
);

async function run() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        print: { type: 'boolean' },
        verify: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    warn(`${err.message}\n\n${usage}`);
    return USAGE;
  }
  if (values.help) {
    say(usage);
    return 0;
  }
  if (Boolean(values.print) === Boolean(values.verify)) {
    warn(`Give one of --print and --verify.\n\n${usage}`);
    return USAGE;
  }

  const { migrations } = loadManifest();

  if (values.print) {
    for (const line of describeManifest(migrations)) say(line);
    const faults = manifestFaults(migrations);
    if (faults.length === 0) return 0;
    warn(`\nThe manifest cannot be judged: ${faults.join('; ')}.`);
    return 1;
  }

  const env = process.env;
  say('sl_app deploy gate — the migrations this commit needs, against the ledger of production');
  const result = await decide({ env, migrations, read: () => readProduction(env) });
  const { out, err, notes } = render(result, { explain });
  for (const line of out) say(line);
  for (const line of err) warn(line);
  // On GitHub, the verdict again as an annotation of the run: it is what the
  // summary page shows, above the log.
  if (env.GITHUB_ACTIONS === 'true') for (const note of notes) say(annotation(note));
  return result.exitCode;
}

// Whatever in the environment is a secret is one from the first line printed.
registerSecret(process.env[SECRET]);
registerSecret(process.env[LOCAL_SECRET]);

try {
  process.exitCode = await run();
} catch (err) {
  // Not a verdict: a bug, or a file that could not be read. The deploy stops
  // all the same — a gate that crashed has not said yes.
  warn(`\nFAILED: ${explain(err)}`);
  if (process.env.GITHUB_ACTIONS === 'true') say(annotation({ level: 'error', title: 'Deploy stopped', text: `The migration check itself failed: ${explain(err).split('\n')[0]}` }));
  process.exitCode = 1;
}
