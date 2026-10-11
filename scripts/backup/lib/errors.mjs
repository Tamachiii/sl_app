// An error the backup tools raise on purpose: its message is written for the
// person at the terminal and is printed without a stack. Anything else that
// reaches the top is a bug or the outside world (network, disk) and is printed
// the same way, scrubbed — see cli.mjs.

export class BackupError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BackupError';
    this.exitCode = exitCode;
  }
}

/** Exit code for "the command line or the environment is wrong". */
export const USAGE = 2;
