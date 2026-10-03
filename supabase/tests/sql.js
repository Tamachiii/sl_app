// SQL as text: run a whole file the way the Supabase SQL editor does, and cut
// one into its statements. Shared by postgres.js (the template build) and
// harness.js (the databases a test builds itself); no vitest import, so both
// the main process and the workers can load it.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Run `sql` as ONE multi-statement simple query — exactly what happens when a
 * file is pasted in the Supabase SQL editor or sent with `supabase db query
 * --file`: the statements share one implicit transaction unless the text opens
 * its own with BEGIN … COMMIT.
 *
 * On failure the error is rewritten to point at the offending line of `label`
 * (a file path, usually). The original is kept as `cause`; `code` is the
 * SQLSTATE.
 */
export async function runSql(client, sql, label = 'sql') {
  try {
    return await client.query(sql);
  } catch (err) {
    const offset = Number(err.position);
    const line = Number.isFinite(offset) && offset > 0
      ? sql.slice(0, offset - 1).split('\n').length
      : null;
    const detail = [err.detail, err.hint, err.where].filter(Boolean).join('\n  ');
    const wrapped = new Error(
      `${label}${line ? `:${line}` : ''}: ${err.message}${detail ? `\n  ${detail}` : ''}`,
    );
    wrapped.code = err.code;
    wrapped.cause = err;
    wrapped.sqlFile = label;
    throw wrapped;
  }
}

/** runSql() on the content of `file`; errors name the file relative to the cwd. */
export async function runSqlFile(client, file) {
  const sql = await fs.readFile(file, 'utf8');
  return runSql(client, sql, path.relative(process.cwd(), file));
}

/**
 * Cut SQL text into its top-level statements: `[{ text, line }]`, in order.
 *
 * `text` is the statement without its final `;`, with comments replaced by a
 * space — so a rule can be checked with a regular expression without matching
 * something that is only said in a comment. What is inside a string, a quoted
 * identifier or a dollar-quoted body ($$ … $$, the body of a function or a DO
 * block) is kept verbatim, comments and semicolons included: it is one token.
 * `line` is the 1-based line the statement starts on.
 *
 * This is a lexer, not a parser: it knows where a statement ends, not what it
 * means.
 */
export function splitStatements(sql) {
  const statements = [];
  let text = '';
  let startLine = null;
  let line = 1;
  let i = 0;

  const push = () => {
    const trimmed = text.trim();
    if (trimmed) statements.push({ text: trimmed, line: startLine });
    text = '';
    startLine = null;
  };
  // Append source[from, to) to the current statement, counting its lines.
  const take = (to) => {
    const chunk = sql.slice(i, to);
    if (startLine === null && chunk.trim()) {
      startLine = line + (chunk.match(/^\s*/)[0].match(/\n/g)?.length ?? 0);
    }
    text += chunk;
    line += chunk.match(/\n/g)?.length ?? 0;
    i = to;
  };
  // Skip source[i, to) (a comment), leaving one space in its place.
  const skip = (to) => {
    line += sql.slice(i, to).match(/\n/g)?.length ?? 0;
    text += ' ';
    i = to;
  };
  const endOf = (index, length = 1) => (index === -1 ? sql.length : index + length);

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      skip(end === -1 ? sql.length : end);
    } else if (ch === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; }
        else j += 1;
      }
      skip(j);
    } else if (ch === "'") {
      // '' is an escaped quote; in an E'…' string so is \'.
      const escapes = /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/\w/.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      take(Math.min(j + 1, sql.length));
    } else if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j += 1;
      }
      take(Math.min(j + 1, sql.length));
    } else if (ch === '$') {
      // $tag$ … $tag$ — but not $1, and not a `$` inside an identifier.
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 80))?.[0];
      if (tag && !/[A-Za-z_0-9]/.test(sql[i - 1] ?? ' ')) {
        take(endOf(sql.indexOf(tag, i + tag.length), tag.length));
      } else {
        take(i + 1);
      }
    } else if (ch === ';') {
      i += 1;
      push();
    } else {
      take(i + 1);
    }
  }
  push();
  return statements;
}
