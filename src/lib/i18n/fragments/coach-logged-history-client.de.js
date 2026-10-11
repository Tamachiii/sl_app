// Package coach-logged-history-client (review items P3, client half, and P12).
// Folded into de.js by the integrator; see ./README.md.
export default {
  coachLoggedHistory: {
    editor: {
      confirmedBanner:
        'Vom Athleten bestätigt. Diese Einheit ist schreibgeschützt: Was trainiert wurde, bleibt so, wie es eingetragen wurde.',
      loggedBanner:
        'Der Athlet hat in dieser Einheit Sätze eingetragen. Diese Sätze sind gesperrt; alles andere lässt sich weiterhin ändern.',
      openReview: 'Auswertung öffnen',
    },
    slot: {
      setLogged: 'Satz {n} ist eingetragen',
      removeBlocked: 'Diese Übung enthält eingetragene Sätze und kann nicht entfernt werden',
    },
    sheet: {
      openReview: 'Auswertung öffnen',
      inProgress: 'Vom Athleten begonnen, noch nicht bestätigt',
    },
    review: {
      openEditor: 'Editor',
      openEditorAria: 'Diese Einheit im Editor öffnen',
    },
  },
};
