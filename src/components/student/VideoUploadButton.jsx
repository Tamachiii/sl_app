import { useRef, useState } from 'react';
import { useUploadSetVideo, useDeleteSetVideo } from '../../hooks/useSetVideo';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import VideoLightbox from '../ui/VideoLightbox';
import VideoPlayer from '../ui/VideoPlayer';

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
  const [err, setErr] = useState(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  function handlePick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr(null);
    upload.mutate(
      { setLogId, exerciseSlotId, setNumber, file },
      { onError: (e) => setErr(e.message || 'Upload failed') }
    );
  }

  function handleDelete() {
    if (!existingVideo) return;
    if (!window.confirm('Delete this video?')) return;
    deleteVideo.mutate({
      videoId: existingVideo.id,
      storagePath: existingVideo.storage_path,
    });
  }

  const busy = upload.isPending || deleteVideo.isPending;
  // Storage uploads need a live connection (Supabase Storage has no resumable
  // background upload). Playback of already-uploaded videos still works
  // offline via the existing signed-URL cache.
  const uploadDisabled = disabled || busy || !isOnline;

  // Icon-only pill geometry — keeps the SetRow on a single line on small
  // screens. Labels live in aria-label/title for accessibility.
  const iconBtn =
    'inline-flex items-center justify-center w-8 h-8 rounded-full disabled:opacity-50 transition-colors';

  const uploadLabel = !isOnline
    ? t('offline.videoNeedsOnline')
    : upload.isPending
      ? 'Uploading…'
      : existingVideo
        ? 'Replace video'
        : 'Upload video';

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
        {existingVideo ? (
          <>
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
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              aria-label={deleteVideo.isPending ? 'Deleting video…' : 'Delete video'}
              className={`${iconBtn} bg-ink-100 text-ink-500 hover:bg-ink-200`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
              </svg>
            </button>
          </>
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
        )}
      </div>
      {err && (
        <p className="basis-full sl-mono text-[11px] mt-1" style={{ color: 'var(--color-danger)' }}>{err}</p>
      )}

      <VideoLightbox open={viewerOpen} onClose={() => setViewerOpen(false)}>
        {existingVideo && <VideoPlayer storagePath={existingVideo.storage_path} />}
      </VideoLightbox>
    </>
  );
}
