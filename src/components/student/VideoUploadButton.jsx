import { useRef, useState } from 'react';
import { useUploadSetVideo, useDeleteSetVideo } from '../../hooks/useSetVideo';
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

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={handlePick}
        disabled={disabled || busy}
      />
      <div className="inline-flex items-center gap-2 flex-wrap">
        {existingVideo ? (
          <>
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              disabled={busy}
              className="sl-pill bg-accent/15 disabled:opacity-50"
              style={{ color: 'var(--color-accent)' }}
            >
              <svg className="w-3 h-3 inline-block mr-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              PLAY
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
            >
              {upload.isPending ? 'Uploading…' : 'Replace'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="sl-pill bg-ink-100 text-ink-500 hover:bg-ink-200 disabled:opacity-50"
            >
              {deleteVideo.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy}
            className="sl-pill disabled:opacity-50"
            style={{ background: 'var(--color-warn)', color: 'var(--color-ink-900)' }}
          >
            <svg className="w-3 h-3 inline-block mr-1" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {upload.isPending ? 'Uploading…' : 'Upload video'}
          </button>
        )}
      </div>
      {err && (
        <p className="basis-full sl-mono text-[11px] mt-1" style={{ color: 'var(--color-danger)' }}>{err}</p>
      )}

      <VideoLightbox open={viewerOpen} onClose={() => setViewerOpen(false)}>
        {existingVideo && <VideoPlayer storagePath={existingVideo.storage_path} className="w-full" />}
      </VideoLightbox>
    </>
  );
}
