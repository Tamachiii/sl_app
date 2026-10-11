import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';

/**
 * Stands where SessionFeedbackComposer would, at the bottom of SessionReview,
 * while the session cannot be reviewed because no confirmation is known for
 * it. A review needs one: the database refuses `reviewed_at` and a feedback
 * message for a session that has none, so the form is not offered at all.
 *
 * Two cases, and they must not be confused:
 *   - default: the confirmation was read and there is none. The athlete has
 *     not confirmed yet (a session in progress, opened from the sheet or from
 *     a deviation notification) or has undone it (a "Session completed"
 *     notification that went stale).
 *   - `unverified`: the read failed or is waiting for the network. Nothing is
 *     known, so nothing is claimed; the coach can ask again.
 *
 * Same layout and neutral tone as SessionReviewedNoFeedback.
 */
export default function SessionReviewNotConfirmed({
  unverified = false,
  onRetry,
  retrying = false,
  studentProfileId,
  onFinish,
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <div className="rounded-xl p-4 space-y-3 bg-ink-100 border border-ink-200">
      <div>
        <div className="sl-label text-ink-400">{t('feedback.sectionLabel')}</div>
        <h2 className="sl-display text-[16px] text-gray-900 leading-tight mt-0.5">
          {unverified
            ? t('coachReviewConfirmation.unverified.title')
            : t('coachReviewConfirmation.feedback.title')}
        </h2>
      </div>

      <p className="text-[13px] text-ink-600">
        {unverified
          ? t('coachReviewConfirmation.unverified.body')
          : t('coachReviewConfirmation.feedback.body')}
      </p>

      <div className="flex flex-wrap gap-2 pt-1">
        {unverified && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="sl-btn-primary text-[12px] disabled:opacity-50"
            style={{ padding: '8px 12px' }}
          >
            {retrying
              ? t('coachReviewConfirmation.unverified.checking')
              : t('coachReviewConfirmation.unverified.retry')}
          </button>
        )}
        {studentProfileId && (
          <button
            type="button"
            onClick={() => navigate(`/coach/messages/${studentProfileId}`)}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            {t('feedback.openThread')}
          </button>
        )}
        <button
          type="button"
          onClick={onFinish}
          className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
        >
          {t('feedback.backToSessions')}
        </button>
      </div>
    </div>
  );
}
