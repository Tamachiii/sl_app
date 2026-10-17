// Package coach-logged-history-client (review items P3, client half, and P12).
// Folded into en.js by the integrator; see ./README.md.
export default {
  coachLoggedHistory: {
    editor: {
      confirmedBanner:
        'Confirmed by the athlete. This session is read-only, so what was trained stays as it was logged.',
      loggedBanner:
        'The athlete has logged sets in this session. Those sets are locked; everything else can still be changed.',
      openReview: 'Open the review',
    },
    slot: {
      setLogged: 'Set {n} is logged',
      removeBlocked: 'This exercise has logged sets and cannot be removed',
    },
    athlete: {
      actionsLabel: 'Go to {name}’s messages or sessions',
    },
  },
};
