// Package coach-review-needs-confirmation (coach half of review item P57).
// Folded into fr.js by the integrator; see ./README.md.
export default {
  coachReviewConfirmation: {
    status: {
      title: 'Non confirmée',
      body: 'L’athlète n’a pas confirmé cette séance, ou a annulé sa confirmation. Ce qui est enregistré pour l’instant figure ci-dessous.',
    },
    feedback: {
      title: 'Rien à revoir pour l’instant.',
      body: 'Une séance peut être revue une fois que l’athlète l’a confirmée. En attendant, tu peux lui écrire.',
    },
    unverified: {
      title: 'Confirmation non vérifiée.',
      body: 'La confirmation de cette séance n’a pas pu être lue à l’instant : la revue n’est donc pas proposée. Vérifie ta connexion et réessaie.',
      retry: 'Vérifier à nouveau',
      checking: 'Vérification…',
    },
  },
};
