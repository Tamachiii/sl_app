// Package coach-tenant-filters-library (review items L2 and L7): the dialog
// that stands in front of deleting a library exercise.
// Folded into de.js by the integrator; see ./README.md.
export default {
  coachLibraryDelete: {
    checking: 'Verwendung wird geprüft…',
    unused: 'Keine Einheit, kein Ziel und kein Tausch verwendet sie. Das Löschen lässt sich nicht rückgängig machen.',
    inUse: 'Sie wird verwendet und kann deshalb nicht gelöscht werden.',
    slots: 'In Einheiten verschrieben',
    goals: 'Darauf gesetzte Ziele',
    swaps: 'Von einem Athleten eingetauscht',
    inUseHelp: 'Einheiten, Ziele und der darauf eingetragene Fortschritt hängen an ihr. Entferne sie zuerst aus diesen Einheiten und Zielen. Archivierte Einheiten und Programme im Papierkorb zählen mit.',
    failed: 'Es konnte nicht geprüft werden, wo diese Übung verwendet wird. Sie wird deshalb nicht gelöscht. Prüfe deine Verbindung und versuche es erneut.',
    retry: 'Erneut prüfen',
    retrying: 'Wird geprüft…',
    ok: 'OK',
  },
};
