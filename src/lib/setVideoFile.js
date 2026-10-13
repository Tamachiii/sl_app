// What a set video must be before anything is sent.
//
// The bucket `set-videos` takes three types and 30 MB (supabase/schema.sql,
// "Storage bucket"); the client stops at 25 MB. A file the bucket refuses is
// refused here first, by the hook and by the button alike: a phone that hands
// over `video/3gpp`, or a file with no type at all, used to be sent in full
// and thrown away by the server every time.

export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

const EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const MB = 1024 * 1024;

// The type of the file without its parameters, in lower case. A recorder
// writes `video/webm;codecs=vp9`: the bucket's list holds `video/webm`, and so
// does the row.
export function videoMimeType(file) {
  return String(file?.type ?? '').split(';')[0].trim().toLowerCase();
}

export function videoExtension(mimeType) {
  return EXTENSIONS[mimeType] ?? 'bin';
}

// null when the file can be sent, or what is wrong with it:
//   { code: 'type', type }             not one of the bucket's three types
//   { code: 'empty' }                  no bytes (iOS hands one over when it
//                                      could not fetch the clip from iCloud)
//   { code: 'size', megabytes, maxMegabytes }
export function videoFileProblem(file) {
  const type = videoMimeType(file);
  if (!ACCEPTED_VIDEO_TYPES.includes(type)) return { code: 'type', type };
  const size = Number(file?.size);
  // `size_bytes` is CHECK (size_bytes > 0): an empty file would be uploaded
  // and then refused at the row.
  if (!(size > 0)) return { code: 'empty' };
  if (size > MAX_VIDEO_BYTES) {
    return {
      code: 'size',
      megabytes: (size / MB).toFixed(1),
      maxMegabytes: MAX_VIDEO_BYTES / MB,
    };
  }
  return null;
}

const PROBLEM_TEXT = {
  type: 'Unsupported video type: use an MP4, MOV or WebM file.',
  empty: 'The video file is empty.',
  size: 'The video is larger than 25 MB.',
};

// The same refusal as an Error, for a caller that reaches the hook without
// the button's check. `videoProblem` is what tells it apart from a failure of
// the upload itself.
export function videoFileError(problem) {
  const error = new Error(PROBLEM_TEXT[problem.code] ?? 'The video cannot be uploaded.');
  error.videoProblem = problem.code;
  return error;
}

// What goes into the request. The part of a multipart upload carries the type
// of the Blob it holds, and that is what the bucket compares with its list: a
// file whose type has parameters or capitals is sent as a view of the same
// bytes under the bare type.
export function videoUploadBody(file) {
  const type = videoMimeType(file);
  return file.type === type ? file : file.slice(0, file.size, type);
}
