// Package coach-duplicate-rpc (review item P52, client half).
// Folded into en.js by the integrator; see ./README.md.
//
// Both sentences are written around a number that can be 1: no word in them
// agrees with it.
export default {
  coachDuplicateRpc: {
    // A copy that left exercises out (`slots_left_out` of the copy functions).
    leftOut: 'Exercises left out of the copy: {n} — not in your library.',
    // useArchiveSessions, when some of the selected sessions were written and
    // one was not.
    archivePartial: '{done} of\u00a0{total} archived. The rest could not be saved — try again.',
    restorePartial: '{done} of\u00a0{total} restored. The rest could not be saved — try again.',
  },
};
