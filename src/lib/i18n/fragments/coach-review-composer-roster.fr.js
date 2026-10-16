// Package coach-review-composer-roster (wave 3, review items P47, P48, L14,
// B28; live items N12, N14, N16). Folded into fr.js by the integrator; see
// ./README.md.
export default {
  coachReviewComposerRoster: {
    finish: {
      confirmTitle: 'Terminer sans envoyer ?',
      confirmMessage: 'Ce que tu as écrit n’a pas été envoyé. Terminer marque la séance comme revue, ce qui est définitif, et efface le texte.',
      confirmAction: 'Terminer et effacer',
    },
    roster: {
      loading: 'Chargement du statut de tes athlètes',
      failedTitle: 'Impossible de charger le statut des athlètes',
      failedBody: 'Les programmes et les séances à revoir peuvent manquer sur les cartes ci-dessous. Vérifie ta connexion, puis réessaie.',
      offlineTitle: 'Le statut des athlètes n’est pas encore sur cet appareil',
      offlineBody: 'Tu es hors ligne. Les programmes et les séances à revoir peuvent manquer sur les cartes ci-dessous jusqu’au retour de la connexion.',
    },
  },
};
