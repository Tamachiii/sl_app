// Everything the database suite loads into the vitest main process: the real
// global-setup.js and, through it, postgres.js and the server library whose
// exit hook answers `beforeExit` with process.exit(0). Its default export is
// never called, so no PostgreSQL is started: the hook is installed by the
// import alone, and so is what postgres.js does about it.
import '../../global-setup.js';

export default function setup() {}
