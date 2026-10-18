// Package video-upload-robust (review items P29 and B30).
// Folded into en.js by the integrator; see ./README.md.
export default {
  videoUpload: {
    progressLabel: 'Video upload',
    uploading: 'Uploading video… {n}%',
    cancelling: 'Cancelling the upload…',
    cancel: 'Cancel upload',
    wrongType: 'This file type is not supported. Use an MP4, MOV or WebM video.',
    tooLarge:
      'This video is {size}\u00a0MB and the limit is {max}\u00a0MB. Record a shorter clip or lower the quality.',
    empty: 'This file is empty. Pick the video again.',
    failed: 'The video was not uploaded. Try again.',
    connectionLost: 'The connection dropped during the upload. Try again.',
  },
};
