import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { reportError } from '../lib/errorReporter';
import { mutationErrorKey } from '../lib/mutationErrors';
import { pushToast } from '../lib/toast';
import {
  videoFileProblem,
  videoFileError,
  videoMimeType,
  videoExtension,
  videoUploadBody,
} from '../lib/setVideoFile';
import { uploadObject, abortError, isAbortError, UPLOAD_NETWORK } from '../lib/storageUpload';
import { beginVideoUpload } from '../lib/setVideoUploads';
import { useAuth } from './useAuth';

const BUCKET = 'set-videos';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Did the database answer "no"? A refusal carries a SQLSTATE (`42501`,
// `23505`) or a PostgREST code (`PGRST116`). A request that got no answer — the
// connection dropped, a gateway timed out — carries neither, and then nobody
// knows whether the row was written.
function refusedByDatabase(error) {
  return /^([0-9A-Z]{5}|PGRST\d+)$/.test(String(error?.code ?? ''));
}

// Removes a file that no row names. Never throws and never fails its caller:
// what it could not remove stays in the bucket, readable by the athlete and
// the coach and shown nowhere, and is reported so that the owner can find it.
async function removeUnreferenced(storagePath, what) {
  let problem = null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (error) problem = error.message || String(error);
    // Storage answers with an empty list and no error when its policy keeps
    // the file out of reach.
    else if (Array.isArray(data) && data.length === 0) problem = 'nothing was removed';
  } catch (e) {
    problem = e?.message || String(e);
  }
  if (problem) {
    reportError(null, `set-videos: ${what} left in the bucket at ${storagePath} (${problem})`);
  }
}

export function useSetVideos(sessionId, slotIds) {
  const sortedIds = [...(slotIds || [])].sort();
  return useQuery({
    queryKey: ['set-videos', sessionId, sortedIds],
    queryFn: async () => {
      if (sortedIds.length === 0) return [];
      // One join instead of "fetch every set_log in the session, then feed its
      // ids back as an .in(...) list" — the second list was the larger of the
      // two and most of it had no video attached.
      const { data, error } = await supabase
        .from('set_log_videos')
        .select('*, set_log:set_logs!inner(exercise_slot_id, set_number)')
        .in('set_log.exercise_slot_id', sortedIds);
      if (error) throw error;
      // Flatten back to the shape SessionView and SessionReview already read.
      return (data || []).map(({ set_log: log, ...video }) => ({
        ...video,
        exercise_slot_id: log?.exercise_slot_id,
        set_number: log?.set_number,
      }));
    },
    enabled: !!sessionId && sortedIds.length > 0,
  });
}

// The one line an upload that failed is told with — a toast, pushed by the
// hook and not by the button, because the button may be gone by then (its
// card closes when the last set of the exercise is ticked) while the upload
// goes on. A cancelled upload is not a failure and says nothing.
function uploadErrorKey(error) {
  if (error?.videoProblem === 'type' || String(error?.statusCode) === '415') {
    return 'videoUpload.wrongType';
  }
  if (error?.code === UPLOAD_NETWORK) return 'videoUpload.connectionLost';
  // What the app already has a sentence for (a refusal of row-level security:
  // the session was closed in the meantime) keeps it.
  const known = mutationErrorKey(error);
  return known === 'errors.generic' ? 'videoUpload.failed' : known;
}

// Saves the clip of a set. The order is what keeps the previous clip safe:
//
//   1. the new file is uploaded, at a path of its own;
//   2. the row of the set is pointed at it — an UPDATE of the row that is
//      there (`set_log_id` is UNIQUE: there is no second row to insert), an
//      INSERT when the set had no video;
//   3. only then is the previous file removed.
//
// Whatever fails, the row names a file that exists. A failed or cancelled
// upload touches nothing. A refused row write removes the new file. A failed
// step 3 leaves one file too many and is not an error for the athlete.
//
// `signal` is the cancel. It is honoured up to the row write and not after:
// once the row names the new file the replace has happened.
async function saveSetVideo({
  userId,
  setLogId,
  exerciseSlotId,
  setNumber,
  file,
  signal,
  onProgress,
}) {
  const { data: existing, error: existErr } = await supabase
    .from('set_log_videos')
    .select('id, storage_path')
    .eq('set_log_id', setLogId)
    .maybeSingle();
  if (existErr) throw existErr;

  const mimeType = videoMimeType(file);
  const uid =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // The database holds a video to this path: <athlete>/<slot of the set>/<file>.
  const storagePath = `${userId}/${exerciseSlotId}/${setNumber}-${uid}.${videoExtension(mimeType)}`;

  // Rejects with an AbortError when `signal` aborts, before or during the
  // request: nothing is in the bucket then.
  await uploadObject({
    bucket: BUCKET,
    path: storagePath,
    body: videoUploadBody(file),
    signal,
    onProgress,
  });

  // Cancelled once the bytes were in: the file is there and no row names it.
  if (signal?.aborted) {
    await removeUnreferenced(storagePath, 'the file of a cancelled upload');
    throw abortError();
  }

  const fields = { storage_path: storagePath, mime_type: mimeType, size_bytes: file.size };
  const write = existing
    ? supabase.from('set_log_videos').update(fields).eq('id', existing.id)
    : supabase.from('set_log_videos').insert({ set_log_id: setLogId, ...fields });
  const { data, error: rowErr } = await write.select().single();
  if (rowErr) {
    if (refusedByDatabase(rowErr)) {
      await removeUnreferenced(storagePath, 'the file of a refused video');
    } else {
      // No answer: the row may name the new file by now. Removing it could
      // leave a row without its file, so it stays, and is reported.
      reportError(
        null,
        `set-videos: the row write of ${storagePath} got no answer, the file was kept (${rowErr.message})`,
      );
    }
    throw rowErr;
  }

  if (existing && existing.storage_path !== storagePath) {
    await removeUnreferenced(existing.storage_path, 'a replaced video');
  }
  return data;
}

export function useUploadSetVideo() {
  const qc = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    // `onError` below is the one place a failed upload is told from; the
    // query client's toast would be a second one, and would fire on a cancel.
    meta: { skipErrorToast: true },
    mutationFn: async ({ setLogId, exerciseSlotId, setNumber, file }) => {
      if (!user?.id) throw new Error('Not signed in');
      if (!file) throw new Error('No file selected');
      // Before any request: the bucket would refuse the file after it was
      // sent in full.
      const problem = videoFileProblem(file);
      if (problem) throw videoFileError(problem);

      // Progress and cancel live beside the mutation, by set, where a button
      // that was unmounted and came back finds them (lib/setVideoUploads).
      const inFlight = beginVideoUpload(setLogId);
      if (!inFlight) throw new Error('A video is already uploading for this set');
      try {
        return await saveSetVideo({
          userId: user.id,
          setLogId,
          exerciseSlotId,
          setNumber,
          file,
          signal: inFlight.signal,
          onProgress: inFlight.progress,
        });
      } finally {
        inFlight.end();
      }
    },
    onError: (error) => {
      if (isAbortError(error)) return;
      pushToast(uploadErrorKey(error), { kind: 'error' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['set-videos'] });
    },
  });
}

export function useDeleteSetVideo() {
  const qc = useQueryClient();

  return useMutation({
    // The row first, then its file — and the file only when the row is really
    // gone. The other way round, a row delete that fails or reaches no row
    // (the database answers an athlete's delete on a closed session that way)
    // leaves a row whose file no longer exists.
    mutationFn: async ({ videoId, storagePath }) => {
      const { data, error } = await supabase
        .from('set_log_videos')
        .delete()
        .eq('id', videoId)
        .select('id');
      if (error) throw error;
      if (!data?.length) return { deleted: false };
      await removeUnreferenced(storagePath, 'a deleted video');
      return { deleted: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['set-videos'] });
    },
  });
}

export function useSetVideoSignedUrl(storagePath) {
  return useQuery({
    queryKey: ['set-video-url', storagePath],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      if (error) throw error;
      return data.signedUrl;
    },
    enabled: !!storagePath,
    staleTime: (SIGNED_URL_TTL_SECONDS - 60) * 1000,
  });
}
