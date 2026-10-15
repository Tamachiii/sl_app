// Package coach-editor-nav-errors (review items P46, P49, L11, B27; parts of P53, L15, B8).
// Folded into de.js by the integrator; see ./README.md.
export default {
  coachEditorNavErrors: {
    read: {
      offlineTitle: 'Das ist noch nicht auf diesem Gerät',
      offlineBody: 'Du bist offline. Es wird geladen, sobald die Verbindung wieder da ist.',
      errorTitle: 'Das konnte nicht geladen werden',
      errorBody: 'Prüfe deine Verbindung und versuche es erneut.',
      retry: 'Erneut versuchen',
    },
    session: {
      notFoundTitle: 'Einheit nicht gefunden',
      notFoundBody: 'Sie wurde gelöscht, oder der Link ist veraltet.',
      backToAthlete: 'Zurück zum Athleten',
      goBack: 'Zurück',
    },
    athlete: {
      notFoundTitle: 'Athlet nicht gefunden',
      notFoundBody: 'Dieser Athlet ist nicht in deiner Liste. Der Link ist vielleicht veraltet.',
    },
    program: {
      notFoundTitle: 'Programm nicht gefunden',
      notFoundBody: 'Dieser Block wurde gelöscht, oder der Link ist veraltet.',
      showCurrent: 'Aktuellen Block anzeigen',
    },
    draft: {
      sheet: 'Dieser Block ist ein Entwurf deines Athleten. Er bleibt schreibgeschützt, bis du ihn über das Menü ⋯ neben seinem Namen freigibst.',
      editor: 'Diese Einheit gehört zu einem Entwurf deines Athleten. Sie bleibt schreibgeschützt, bis du den Entwurf freigibst.',
    },
  },
};
