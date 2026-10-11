// Package coach-review-needs-confirmation (coach half of review item P57).
// Folded into de.js by the integrator; see ./README.md.
export default {
  coachReviewConfirmation: {
    status: {
      title: 'Nicht bestätigt',
      body: 'Der Athlet hat diese Einheit nicht bestätigt oder die Bestätigung zurückgenommen. Was bisher eingetragen ist, steht unten.',
    },
    feedback: {
      title: 'Noch nichts auszuwerten.',
      body: 'Eine Einheit kann ausgewertet werden, sobald der Athlet sie bestätigt hat. Bis dahin kannst du ihm schreiben.',
    },
    unverified: {
      title: 'Bestätigung nicht geprüft.',
      body: 'Die Bestätigung dieser Einheit konnte gerade nicht gelesen werden. Die Auswertung wird deshalb nicht angeboten. Prüfe deine Verbindung und versuche es erneut.',
      retry: 'Erneut prüfen',
      checking: 'Wird geprüft…',
    },
  },
};
