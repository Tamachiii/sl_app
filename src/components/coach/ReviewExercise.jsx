import { useId } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber } from '../../lib/i18n/format';
import { prescriptionText } from '../../lib/prescriptionText';
import { getSlotTargetRest, isSlotUniform } from '../../lib/volume';
import { restText } from '../student/sessionModel';
import { Button, Icon } from '../parc';
import { setRows } from './reviewModel';

// The mark at the left of a row, as on the athlete's sets (design/parc/
// components/SetRow): done a blue disc, failed a red one, the rest a ring.
const DOT = {
  done: 'pk-set-dot pk-set-dot-done',
  offPlan: 'pk-set-dot pk-set-dot-done',
  added: 'pk-set-dot pk-set-dot-done',
  failed: 'pk-set-dot pk-set-dot-failed',
  skipped: 'pk-set-dot pk-set-dot-pending',
  notDone: 'pk-set-dot pk-set-dot-pending',
};

function SetRowView({ row }) {
  const tinted = row.kind === 'failed' ? 'bg-red-soft' : row.kind === 'offPlan' || row.kind === 'added' ? 'bg-amber-soft' : '';
  return (
    <li className={`pk-row ${tinted ? `-mx-4 px-4 ${tinted}` : ''}`}>
      <span className={DOT[row.kind]} aria-hidden="true">
        {row.kind === 'failed' ? (
          <Icon name="close" size={16} />
        ) : row.kind === 'skipped' ? (
          <Icon name="skip" size={14} />
        ) : row.kind === 'notDone' ? null : (
          <Icon name="check" size={16} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`pk-body font-semibold ${row.kind === 'failed' ? 'text-red' : ''}`}>{row.title}</div>
        {row.caption && (
          <div className={`pk-caption ${row.kind === 'offPlan' || row.kind === 'added' ? 'text-amber' : ''}`}>
            <span className="sr-only">,</span> {row.caption}
          </div>
        )}
      </div>
      {row.rpe && (
        <span className="whitespace-nowrap text-[15px] font-semibold">
          <span className="sr-only">,</span> {row.rpe}
        </span>
      )}
    </li>
  );
}

function VideoRow({ video, onPlay }) {
  const { t, lang } = useI18n();
  return (
    <li>
      <button type="button" onClick={() => onPlay(video)} className="pk-row w-full bg-transparent text-left">
        <span aria-hidden="true" className="flex h-11 w-16 shrink-0 items-center justify-center rounded-control bg-ink text-surface">
          <Icon name="play" size={20} />
        </span>
        <span className="pk-body min-w-0 flex-1 font-semibold">
          {t('parcReview.video', { n: formatNumber(lang, video.set_number) })}
        </span>
        <Icon name="chevron-right" size={18} className="shrink-0 text-ink-2" />
      </button>
    </li>
  );
}

/**
 * One exercise of the review: its name and what was planned — or, for a
 * swap, what it replaced — then a row per set (the sets done as planned in
 * one), the video of a set under its row, and the athlete's note. A swap or a
 * skip offers to carry it into the program, online; the athlete's request to
 * keep it is said above, with « Refuser ».
 */
export default function ReviewExercise({
  slot,
  logs,
  deviation,
  substituteName,
  comment,
  videos,
  athleteName,
  adopted,
  online,
  declining,
  onDecline,
  onAdopt,
  onRemove,
  onPlay,
}) {
  const ctx = useI18n();
  const { t } = ctx;
  const titleId = useId();
  const ex = slot.exercise;
  const exerciseName = ex?.name ?? t('coachEditorNavErrors.exercise.unavailableTitle');
  const swapped = deviation?.kind === 'swap';
  const skipped = deviation?.kind === 'skip';
  // What the coach prescribed: a set the athlete added has no target.
  const plannedLogs = logs.filter((l) => !l.is_student_added);
  const composed = { ...slot, set_logs: plannedLogs };
  const rest = isSlotUniform(composed) ? getSlotTargetRest(composed) : null;
  const plan = prescriptionText(composed, ctx);
  const planLine = [plan ? t('parcReview.planned', { what: plan }) : null, rest ? t('parcReview.rest', { time: restText(rest) }) : null]
    .filter(Boolean)
    .join(', ');
  const rows = setRows(logs, ctx, { swapped });
  const videosOf = (numbers) =>
    (videos || []).filter((v) => numbers.includes(v.set_number)).sort((a, b) => a.set_number - b.set_number);

  return (
    <section aria-labelledby={titleId} className="rounded-group bg-surface px-4">
      <div className="flex min-h-15 flex-col justify-center gap-0.5 border-b border-line py-3">
        <h2 id={titleId} className={`pk-headline ${ex ? '' : 'text-ink-2'}`}>
          {swapped ? substituteName : exerciseName}
        </h2>
        {!ex && <p className="pk-caption">{t('coachEditorNavErrors.exercise.unavailableBody')}</p>}
        {swapped ? (
          <p className="pk-caption text-amber">{t('parcReview.replaces', { name: exerciseName })}</p>
        ) : skipped ? (
          <p className="pk-caption text-amber">{t('parcReview.skippedExercise')}</p>
        ) : (
          planLine && <p className="pk-caption">{planLine}</p>
        )}
        {deviation && (
          <DeviationActions
            deviation={deviation}
            adopted={adopted}
            online={online}
            declining={declining}
            onDecline={onDecline}
            onAdopt={onAdopt}
            onRemove={onRemove}
          />
        )}
      </div>
      {rows.length > 0 && (
        <ol aria-label={t('parcReview.setsOf', { name: swapped ? substituteName : exerciseName })} className="flex flex-col">
          {rows.map((row) => (
            <RowAndVideos key={row.key} row={row} videos={videosOf(row.numbers)} onPlay={onPlay} />
          ))}
        </ol>
      )}
      {comment && (
        <div className="border-t border-line py-3">
          <h3 className="text-[15px] font-bold leading-[1.4]">
            {athleteName ? t('parcReview.noteOf', { name: athleteName }) : t('parcReview.note')}
          </h3>
          <p className="pk-body mt-1 whitespace-pre-wrap">{comment.body}</p>
        </div>
      )}
    </section>
  );
}

function RowAndVideos({ row, videos, onPlay }) {
  return (
    <>
      <SetRowView row={row} />
      {videos.map((video) => (
        <VideoRow key={video.id} video={video} onPlay={onPlay} />
      ))}
    </>
  );
}

function DeviationActions({ deviation, adopted, online, declining, onDecline, onAdopt, onRemove }) {
  const { t } = useI18n();
  const swap = deviation.kind === 'swap';
  if (adopted) {
    return <p className="pk-caption mt-1">{t(swap ? 'parcReview.adopted' : 'parcReview.removed')}</p>;
  }
  const canAdopt = swap ? !!deviation.substitute_exercise_id : true;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {deviation.promote_requested_at && (
        <p className="pk-caption font-semibold text-blue">{t('parcReview.promoteAsked')}</p>
      )}
      {online ? (
        <div className="flex flex-wrap gap-2">
          {canAdopt && (
            <Button variant="secondary" onClick={swap ? onAdopt : onRemove}>
              {t(swap ? 'parcReview.adopt' : 'parcReview.removeForward')}
            </Button>
          )}
          {deviation.promote_requested_at && (
            <Button variant="text" onClick={onDecline} disabled={declining}>
              {t('parcReview.decline')}
            </Button>
          )}
        </div>
      ) : (
        canAdopt && <p className="pk-caption">{t(swap ? 'parcReview.offlineAdopt' : 'parcReview.offlineRemove')}</p>
      )}
    </div>
  );
}
