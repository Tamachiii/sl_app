// Package video-upload-robust (review items P29 and B30).
// Folded into de.js by the integrator; see ./README.md.
export default {
  videoUpload: {
    progressLabel: 'Video-Upload',
    uploading: 'Video wird hochgeladen … {n}\u00a0%',
    cancelling: 'Upload wird abgebrochen …',
    cancel: 'Upload abbrechen',
    wrongType: 'Dieser Dateityp wird nicht unterstützt. Nimm ein MP4-, MOV- oder WebM-Video.',
    tooLarge:
      'Dieses Video hat {size}\u00a0MB, erlaubt sind {max}\u00a0MB. Nimm einen kürzeren Clip auf oder verringere die Qualität.',
    empty: 'Diese Datei ist leer. Wähle das Video noch einmal aus.',
    failed: 'Das Video wurde nicht hochgeladen. Versuch es noch einmal.',
    connectionLost: 'Die Verbindung ist während des Uploads abgebrochen. Versuch es noch einmal.',
  },
};
