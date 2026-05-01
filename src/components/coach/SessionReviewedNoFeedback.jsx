import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { formatMessageStamp } from '../../hooks/useMessages';

/**
 * Read-only card shown at the bottom of SessionReview when the coach finished
 * the review flow without leaving feedback (`sessions.reviewed_at` set, no
 * matching feedback message). Mirrors SessionFeedbackSent's layout but omits
 * the body and uses a neutral (ink) tone instead of success-green so the two
 * states read differently at a glance.
 */
export default function SessionReviewedNoFeedback({
  reviewedAt,
  studentProfileId,
  onFinish,
}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();

  return (
    <div className="rounded-xl p-4 space-y-3 bg-ink-100 border border-ink-200">
      <div className="flex items-center gap-2 sl-label text-ink-600">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
        {t('feedback.reviewedNoFeedbackTitle')}
      </div>

      <p className="text-[13px] text-ink-600">{t('feedback.reviewedNoFeedbackBody')}</p>

      {reviewedAt && (
        <p className="sl-mono text-[11px] text-ink-400">
          {t('feedback.reviewedAt', {
            when: formatMessageStamp(reviewedAt, lang),
          })}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
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
