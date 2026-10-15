// Package coach-editor-nav-errors (review items P46, P49, L11, B27; parts of P53, L15, B8).
// Folded into en.js by the integrator; see ./README.md.
export default {
  coachEditorNavErrors: {
    read: {
      offlineTitle: 'This isn’t on this device yet',
      offlineBody: 'You’re offline. It will load as soon as the connection is back.',
      errorTitle: 'This couldn’t be loaded',
      errorBody: 'Check your connection, then try again.',
      retry: 'Try again',
    },
    session: {
      notFoundTitle: 'Session not found',
      notFoundBody: 'It was deleted, or the link is out of date.',
      backToAthlete: 'Back to the athlete',
      goBack: 'Go back',
    },
    athlete: {
      notFoundTitle: 'Athlete not found',
      notFoundBody: 'This athlete isn’t on your roster. The link may be out of date.',
    },
    program: {
      notFoundTitle: 'Program not found',
      notFoundBody: 'This block was deleted, or the link is out of date.',
      showCurrent: 'Show the current block',
    },
    draft: {
      sheet: 'This block is a draft written by your athlete. It stays read-only until you approve it from the ⋯ menu beside its name.',
      editor: 'This session is part of a draft written by your athlete. It stays read-only until you approve the draft.',
    },
    exercise: {
      unavailableTitle: 'Exercise unavailable',
      unavailableBody: 'It comes from a library you can’t read, such as a former coach’s.',
    },
  },
};
