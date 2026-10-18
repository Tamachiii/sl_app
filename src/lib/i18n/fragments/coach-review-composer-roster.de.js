// Package coach-review-composer-roster (wave 3, review items P47, P48, L14,
// B28; live items N12, N14, N16). Folded into de.js by the integrator; see
// ./README.md.
export default {
  coachReviewComposerRoster: {
    finish: {
      confirmTitle: 'Ohne Senden beenden?',
      confirmMessage: 'Was du geschrieben hast, wurde nicht gesendet. Beenden markiert die Einheit als geprüft, was endgültig ist, und verwirft den Text.',
      confirmAction: 'Beenden und verwerfen',
    },
    roster: {
      loading: 'Status deiner Athleten wird geladen',
      failedTitle: 'Der Status der Athleten konnte nicht geladen werden',
      failedBody: 'Programme und zu prüfende Einheiten können auf den Karten unten fehlen. Prüfe deine Verbindung und versuche es erneut.',
      offlineTitle: 'Der Status der Athleten ist noch nicht auf diesem Gerät',
      offlineBody: 'Du bist offline. Programme und zu prüfende Einheiten können auf den Karten unten fehlen, bis die Verbindung wieder da ist.',
    },
    archive: {
      done: 'Einheit archiviert',
    },
  },
};
