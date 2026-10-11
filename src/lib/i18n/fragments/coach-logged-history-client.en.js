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
    sheet: {
      openReview: 'Open the review',
      inProgress: 'Started by the athlete, not confirmed yet',
    },
    review: {
      openEditor: 'editor',
      openEditorAria: 'Open this session in the editor',
    },
    roster: {
      reviewChipAria: '{n} to review — {name}’s sessions',
    },
    athlete: {
      actionsLabel: 'Go to {name}’s messages or sessions',
      message: 'Message',
      sessions: 'Sessions',
    },
  },
};
