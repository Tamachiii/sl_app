import { useRef, useState, useSyncExternalStore } from 'react';
import { useUploadSetVideo, useDeleteSetVideo } from '../../hooks/useSetVideo';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import { videoFileProblem } from '../../lib/setVideoFile';
import {
  subscribeVideoUploads,
  getVideoUpload,
  cancelVideoUpload,
} from '../../lib/setVideoUploads';
import VideoLightbox from '../ui/VideoLightbox';
import VideoPlayer from '../ui/VideoPlayer';

const RING_RADIUS = 20;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

// The progress of the upload, drawn around the 44px cancel button.
function ProgressRing({ percent }) {
  return (
    <svg className="absolute inset-0 w-11 h-11" viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <circle cx="22" cy="22" r={RING_RADIUS} stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      {/* Starts at twelve o'clock and runs clockwise. */}
      <circle
        cx="22"
        cy="22"
        r={RING_RADIUS}
        stroke="var(--color-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

export default function VideoUploadButton({
  setLogId,
  exerciseSlotId,
  setNumber,
  existingVideo,
  disabled = false,
}) {
  const inputRef = useRef(null);
  const upload = useUploadSetVideo();
  const deleteVideo = useDeleteSetVideo();
  const isOnline = useOnlineStatus();
  const { t } = useI18n();
  // Why the file that was picked is not sent, or null. The only message this
  // button shows: a file refused here starts no upload, so nothing else says
  // it. An upload that fails is told by the hook, once (useUploadSetVideo).
  const [problem, setProblem] = useState(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  // The upload of this set, wherever it was started from. Its progress and
  // its cancel are kept beside the mutation, not here: this button is
  // unmounted when its card closes — ticking the last set of the exercise
  // does that — while the upload goes on, and the button that comes back
  // must find it (lib/setVideoUploads).
  const inFlight = useSyncExternalStore(
    subscribeVideoUploads,
    () => getVideoUpload(setLogId),
    () => null,
  );

  function handlePick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Before anything is sent: a type the bucket refuses, an empty file or
    // one above the limit would otherwise be uploaded in full first.
    const refused = videoFileProblem(file);
    setProblem(refused);
    if (refused) return;
    upload.mutate({ setLogId, exerciseSlotId, setNumber, file });
  }

  function handleDelete() {
    if (!existingVideo) return;
    if (!window.confirm('Delete this video?')) return;
    deleteVideo.mutate({
      videoId: existingVideo.id,
      storagePath: existingVideo.storage_path,
    });
  }

  const uploading = upload.isPending || !!inFlight;
  const percent = inFlight?.percent ?? 0;
  const cancelling = !!inFlight?.cancelled;
  const busy = uploading || deleteVideo.isPending;
  // Storage uploads need a live connection (Supabase Storage has no resumable
  // background upload). Playback of already-uploaded videos still works
  // offline via the existing signed-URL cache.
  const uploadDisabled = disabled || busy || !isOnline;

  // Icon-only pill geometry — sized to the 44px Apple HIG tap-target
  // minimum so the button is comfortably tappable on mobile. Labels live
  // in aria-label/title for accessibility.
  const iconBtn =
    'inline-flex items-center justify-center w-11 h-11 rounded-full disabled:opacity-50 transition-colors';

  const uploadLabel = !isOnline
    ? t('offline.videoNeedsOnline')
    : existingVideo
      ? 'Replace video'
      : 'Upload video';

  const statusText = cancelling
    ? t('videoUpload.cancelling')
    : t('videoUpload.uploading', { n: percent });

  let problemText = null;
  if (problem?.code === 'type') problemText = t('videoUpload.wrongType');
  else if (problem?.code === 'size') {
    problemText = t('videoUpload.tooLarge', { size: problem.megabytes, max: problem.maxMegabytes });
  } else if (problem) problemText = t('videoUpload.empty');

  // ONE button for "upload / replace" and for "cancel": the same element, so
  // the focus that came back from the file picker stays on it when the upload
  // starts. While a clip is on its way it stops the upload — and stays
  // enabled offline and on a set that was locked in the meantime, because
  // stopping needs neither a connection nor a writable session.
  const uploadOrCancel = uploading ? (
    <button
      type="button"
      onClick={() => cancelVideoUpload(setLogId)}
      disabled={cancelling}
      title={t('videoUpload.cancel')}
      aria-label={t('videoUpload.cancel')}
      className={`${iconBtn} relative bg-ink-100 text-ink-700 hover:bg-ink-200`}
    >
      <ProgressRing percent={percent} />
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  ) : existingVideo ? (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={uploadDisabled}
      title={uploadLabel}
      aria-label={uploadLabel}
      className={`${iconBtn} bg-ink-100 text-ink-700 hover:bg-ink-200`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    </button>
  ) : (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={uploadDisabled}
      title={uploadLabel}
      aria-label={uploadLabel}
      className={iconBtn}
      style={{ background: 'var(--color-warn)', color: 'var(--color-ink-900)' }}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    </button>
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={handlePick}
        disabled={uploadDisabled}
      />
      <div className="inline-flex items-center gap-1.5 flex-wrap">
        {existingVideo && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            disabled={busy}
            aria-label="Play video"
            className={`${iconBtn} bg-accent/15`}
            style={{ color: 'var(--color-accent)' }}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}
        {uploadOrCancel}
        {existingVideo && (
          <button
            type="button"
            onClick={handleDelete}
            // `disabled` is the set's lock (confirmed, reviewed, archived or
            // past-program session). Deleting is a write like replacing:
            // only playing the video survives the lock.
            disabled={busy || disabled}
            aria-label={deleteVideo.isPending ? 'Deleting video…' : 'Delete video'}
            className={`${iconBtn} bg-ink-100 text-ink-500 hover:bg-ink-200`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
            </svg>
          </button>
        )}
      </div>
      {uploading && (
        // A line of its own under the set, like the refusal below: the row
        // has no room for it beside the buttons on a phone. This component
        // renders into the row's wrapping flex container, between the video
        // buttons and the Actual and RPE pills: `order-last` is what puts the
        // line under the whole row instead of pushing those pills below it.
        <div
          role="progressbar"
          aria-label={t('videoUpload.progressLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={statusText}
          className="order-last basis-full sl-mono text-[11px] text-ink-500"
        >
          {statusText}
        </div>
      )}
      {problemText && !uploading && (
        <p
          role="alert"
          className="order-last basis-full sl-mono text-[11px]"
          style={{ color: 'var(--color-danger)' }}
        >
          {problemText}
        </p>
      )}

      <VideoLightbox open={viewerOpen} onClose={() => setViewerOpen(false)}>
        {existingVideo && <VideoPlayer storagePath={existingVideo.storage_path} />}
      </VideoLightbox>
    </>
  );
}
