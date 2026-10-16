// Package rest-push-client (review items P50, B35 and B38).
// Folded into en.js by the integrator; see ./README.md.
//
// The body of the "Rest done" push. hooks/useRestTimerPush reads it with
// getMessage in the app's language when it schedules the push; the title is
// student.session.restDone.
export default {
  restPush: {
    body: 'Time for your next set.',
  },
};
