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
import { Button, ConfirmSheet, Icon } from '../parc';

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
  // Where the player opens: null while it is closed, else the open sheet the
  // button sits in (or the <body>) — see VideoLightbox `container`.
  const [viewer, setViewer] = useState(null);
  const [deleteAsked, setDeleteAsked] = useState(false);
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
  const uploadLabel = existingVideo ? t('parcSession.videoReplace') : t('parcSession.videoSend');

  const statusText = cancelling
    ? t('videoUpload.cancelling')
    : t('videoUpload.uploading', { n: percent });

  // Why the file picked is not sent, said under the buttons.
  let problemText = null;
  if (problem?.code === 'type') problemText = t('videoUpload.wrongType');
  else if (problem?.code === 'size') {
    problemText = t('videoUpload.tooLarge', { size: problem.megabytes, max: problem.maxMegabytes });
  } else if (problem) problemText = t('videoUpload.empty');

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handlePick}
        disabled={uploadDisabled}
      />
      <div className="flex flex-wrap gap-2">
        {existingVideo && (
          <Button
            disabled={busy}
            onClick={(event) => setViewer(event.currentTarget.closest('dialog') ?? document.body)}
          >
            <Icon name="play" size={18} />
            {t('parcSession.videoPlay')}
          </Button>
        )}
        {uploading ? (
          // The upload goes on when the sheet closes (lib/setVideoUploads):
          // its cancel is here whenever the sheet is open again.
          <Button onClick={() => cancelVideoUpload(setLogId)} disabled={cancelling}>
            {t('videoUpload.cancel')}
          </Button>
        ) : (
          <Button onClick={() => inputRef.current?.click()} disabled={uploadDisabled}>
            <Icon name="video" size={18} />
            {uploadLabel}
          </Button>
        )}
        {existingVideo && (
          // `disabled` is the set's lock (confirmed, reviewed, archived or
          // past-program session). Deleting is a write like replacing: only
          // playing the video survives the lock.
          <Button className="text-red" disabled={busy || disabled} onClick={() => setDeleteAsked(true)}>
            {deleteVideo.isPending ? t('parcSession.videoDeleting') : t('parcSession.videoDelete')}
          </Button>
        )}
      </div>
      {!isOnline && !disabled && <p className="pk-caption">{t('offline.videoNeedsOnline')}</p>}
      {uploading && (
        <div
          role="progressbar"
          aria-label={t('videoUpload.progressLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={statusText}
          className="pk-caption pk-tnum"
        >
          {statusText}
        </div>
      )}
      {problemText && !uploading && (
        <p role="alert" className="text-[13px] leading-[1.35] text-red">
          {problemText}
        </p>
      )}

      <ConfirmSheet
        open={deleteAsked}
        onClose={() => setDeleteAsked(false)}
        onConfirm={handleDelete}
        title={t('parcSession.videoDeleteTitle')}
        message={t('parcSession.videoDeleteBody')}
        confirmText={t('parcSession.videoDelete')}
        cancelText={t('parcSession.videoKeep')}
      />
      <VideoLightbox open={viewer != null} onClose={() => setViewer(null)} container={viewer ?? undefined}>
        {existingVideo && <VideoPlayer storagePath={existingVideo.storage_path} />}
      </VideoLightbox>
    </div>
  );
}
