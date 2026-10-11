// What must never reach a terminal, a CI log or an error message: the
// connection string, the database password, the passphrase.
//
// Every value is registered the moment it is read from the environment or the
// command line, and every line the tools print goes through scrub() — the
// expected ones and the ones nobody planned (a driver error that quotes its
// input, a stack). A GitHub log masks a secret only where the exact string
// appears; a password inside a longer URL, or percent-encoded, is not masked
// there, so this does not rely on it.

const secrets = new Set();

/** Remember `value` (and its percent-encoded form) as something to hide. */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return;
  secrets.add(value);
  try {
    secrets.add(encodeURIComponent(value));
  } catch { /* a lone surrogate: nothing more to add */ }
}

/**
 * `text` with every registered secret replaced, and with anything that still
 * looks like a postgres:// URL cut down to its scheme.
 */
export function scrub(text) {
  let out = String(text);
  // Longest first: a password that is part of a registered URL goes with it.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[hidden]');
  }
  return out.replace(/\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi, 'postgres://[hidden]');
}
