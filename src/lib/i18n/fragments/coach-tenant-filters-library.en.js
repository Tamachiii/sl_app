// Package coach-tenant-filters-library (review items L2 and L7): the dialog
// that stands in front of deleting a library exercise.
// Folded into en.js by the integrator; see ./README.md.
export default {
  coachLibraryDelete: {
    checking: 'Checking where it is used…',
    unused: 'No session, goal or swap uses it. Deleting it cannot be undone.',
    inUse: 'It is in use, so it cannot be deleted.',
    slots: 'Prescribed in sessions',
    goals: 'Goals set on it',
    swaps: 'Swapped in by an athlete',
    inUseHelp: 'Sessions, goals and the progress logged on them depend on it. Remove it from those sessions and goals first. Archived sessions and programs in the trash count too.',
    failed: 'Where this exercise is used could not be checked, so it is not deleted. Check your connection and try again.',
    retry: 'Check again',
    retrying: 'Checking…',
    ok: 'OK',
  },
};
