// Package coach-tenant-filters-library (review items L2 and L7): the dialog
// that stands in front of deleting a library exercise.
// Folded into fr.js by the integrator; see ./README.md.
export default {
  coachLibraryDelete: {
    checking: 'Vérification de son utilisation…',
    unused: 'Aucune séance, aucun objectif et aucun remplacement ne l’utilise. La suppression est définitive.',
    inUse: 'Il est utilisé : il ne peut donc pas être supprimé.',
    slots: 'Prescrit en séance',
    goals: 'Objectifs fixés dessus',
    swaps: 'Choisi en remplacement par un athlète',
    inUseHelp: 'Des séances, des objectifs et la progression enregistrée en dépendent. Retire-le d’abord de ces séances et de ces objectifs. Les séances archivées et les programmes à la corbeille comptent aussi.',
    failed: 'Impossible de vérifier où cet exercice est utilisé : il n’est donc pas supprimé. Vérifie ta connexion et réessaie.',
    retry: 'Vérifier à nouveau',
    retrying: 'Vérification…',
  },
};
