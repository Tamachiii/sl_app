// Package coach-review-needs-confirmation (coach half of review item P57).
// Folded into en.js by the integrator; see ./README.md.
export default {
  coachReviewConfirmation: {
    status: {
      title: 'Not confirmed',
      body: 'The athlete has not confirmed this session, or has undone the confirmation. What is logged so far is shown below.',
    },
    feedback: {
      title: 'Nothing to review yet.',
      body: 'A session can be reviewed once the athlete has confirmed it. Until then, you can message them.',
    },
    unverified: {
      title: 'Confirmation not checked.',
      body: 'The confirmation of this session could not be read just now, so the review is not offered. Check your connection and try again.',
      retry: 'Check again',
      checking: 'Checking…',
    },
  },
};
