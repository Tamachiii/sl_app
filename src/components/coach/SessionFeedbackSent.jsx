import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { formatMessageStamp } from '../../hooks/useMessages';

/**
 * Read-only card shown at the bottom of SessionReview when a feedback message
 * already exists for this session. Replaces SessionFeedbackComposer so the
 * coach can't submit twice. The DB also enforces this via a UNIQUE partial
 * index on messages.session_id.
 */
export default function SessionFeedbackSent({
  feedback,
  studentProfileId,
  onFinish,
}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();

  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{
        background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-success) 35%, transparent)',
      }}
    >
      <div
        className="flex items-center gap-2 sl-label"
        style={{ color: 'var(--color-success)' }}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
        {t('feedback.alreadySentTitle')}
      </div>

      <p className="text-[13px] text-ink-700 whitespace-pre-wrap">{feedback.body}</p>

      <p className="sl-mono text-[11px] text-ink-400">
        {t('feedback.alreadySentAt', {
          when: formatMessageStamp(feedback.created_at, lang),
        })}
      </p>

      <div className="flex flex-wrap gap-2 pt-1">
        {studentProfileId && (
          <button
            type="button"
            onClick={() => navigate(`/coach/messages/${studentProfileId}`)}
            className="sl-btn-primary text-[12px]"
            style={{ padding: '8px 12px' }}
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
