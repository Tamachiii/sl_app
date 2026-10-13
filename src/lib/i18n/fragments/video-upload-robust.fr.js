// Package video-upload-robust (review items P29 and B30).
// Folded into fr.js by the integrator; see ./README.md.
export default {
  videoUpload: {
    progressLabel: 'Envoi de la vidéo',
    uploading: 'Envoi de la vidéo… {n} %',
    cancelling: 'Annulation de l’envoi…',
    cancel: 'Annuler l’envoi',
    wrongType: 'Ce type de fichier n’est pas accepté. Utilise une vidéo MP4, MOV ou WebM.',
    tooLarge:
      'Cette vidéo fait {size} Mo et la limite est de {max} Mo. Filme un extrait plus court ou baisse la qualité.',
    empty: 'Ce fichier est vide. Choisis la vidéo à nouveau.',
    failed: 'La vidéo n’a pas été envoyée. Réessaie.',
    connectionLost: 'La connexion a été coupée pendant l’envoi. Réessaie.',
  },
};
