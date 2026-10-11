// Package coach-logged-history-client (review items P3, client half, and P12).
// Folded into fr.js by the integrator; see ./README.md.
export default {
  coachLoggedHistory: {
    editor: {
      confirmedBanner:
        'Séance confirmée par l’athlète. Elle est en lecture seule : ce qui a été fait reste tel qu’il a été enregistré.',
      loggedBanner:
        'L’athlète a enregistré des séries dans cette séance. Ces séries sont verrouillées ; tout le reste peut encore être modifié.',
      openReview: 'Ouvrir la revue',
    },
    slot: {
      setLogged: 'Série {n} enregistrée',
      removeBlocked: 'Cet exercice contient des séries enregistrées et ne peut pas être retiré',
    },
    sheet: {
      openReview: 'Ouvrir la revue',
      inProgress: 'Commencée par l’athlète, pas encore confirmée',
    },
    review: {
      openEditor: 'éditeur',
      openEditorAria: 'Ouvrir cette séance dans l’éditeur',
    },
  },
};
