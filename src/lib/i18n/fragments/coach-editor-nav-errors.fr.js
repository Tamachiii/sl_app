// Package coach-editor-nav-errors (review items P46, P49, L11, B27; parts of P53, L15, B8).
// Folded into fr.js by the integrator; see ./README.md.
export default {
  coachEditorNavErrors: {
    read: {
      offlineTitle: 'Ce contenu n’est pas encore sur cet appareil',
      offlineBody: 'Tu es hors ligne. Il se chargera dès que la connexion reviendra.',
      errorTitle: 'Impossible de charger ce contenu',
      errorBody: 'Vérifie ta connexion, puis réessaie.',
      retry: 'Réessayer',
    },
    session: {
      notFoundTitle: 'Séance introuvable',
      notFoundBody: 'Elle a été supprimée, ou le lien n’est plus à jour.',
      backToAthlete: 'Retour à l’athlète',
      goBack: 'Retour',
    },
    athlete: {
      notFoundTitle: 'Athlète introuvable',
      notFoundBody: 'Cet athlète ne fait pas partie de tes athlètes. Le lien n’est peut-être plus à jour.',
    },
    program: {
      notFoundTitle: 'Programme introuvable',
      notFoundBody: 'Ce bloc a été supprimé, ou le lien n’est plus à jour.',
      showCurrent: 'Afficher le bloc en cours',
    },
  },
};
