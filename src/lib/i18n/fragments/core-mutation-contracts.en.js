// Package core-mutation-contracts (client half of review item P55).
// Folded into en.js by the integrator; see ./README.md.
//
// `refused` is pushed as a toast by lib/offlineMutations.js, once per replay,
// when writes that waited for the network come back refused because their
// session was closed in the meantime. The key is named in lib/mutationErrors.js
// (REPLAY_REFUSED_KEY).
export default {
  offlineReplay: {
    refused:
      'What you logged offline could not be synced: your coach closed this session or changed your block in the meantime. A copy is kept on this device — tell your coach.',
  },
};
