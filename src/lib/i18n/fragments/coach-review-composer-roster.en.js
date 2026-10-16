// Package coach-review-composer-roster (wave 3, review items P47, P48, L14,
// B28; live items N12, N14, N16). Folded into en.js by the integrator; see
// ./README.md.
export default {
  coachReviewComposerRoster: {
    finish: {
      confirmTitle: 'Finish without sending?',
      confirmMessage: 'What you typed has not been sent. Finishing marks the session as reviewed, which cannot be undone, and discards the text.',
      confirmAction: 'Finish and discard',
    },
    roster: {
      loading: 'Loading your athletes’ status',
      failedTitle: 'Athlete status couldn’t be loaded',
      failedBody: 'Programs and sessions to review may be missing from the cards below. Check your connection, then try again.',
      offlineTitle: 'Athlete status isn’t on this device yet',
      offlineBody: 'You’re offline. Programs and sessions to review may be missing from the cards below until the connection is back.',
    },
    review: {
      trainedOn: 'Trained on {date}',
    },
    copy: {
      sessionRange: 'Sessions {from}–{to}',
    },
  },
};
