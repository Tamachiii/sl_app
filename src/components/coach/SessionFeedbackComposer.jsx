import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useSendMessage } from '../../hooks/useMessages';
import { useMarkSessionReviewed } from '../../hooks/useSession';

const MAX_LEN = 4000;

/**
 * Coach-side feedback step rendered at the bottom of SessionReview.
 *
 * Posts a message into the existing coach↔student thread with `session_id`
 * attached. The DB trigger fires a `session_feedback` notification on the
 * student AND stamps `sessions.reviewed_at` so the session is marked
 * reviewed. The coach can also "finish without feedback" — that path stamps
 * `reviewed_at` directly via useMarkSessionReviewed before navigating back,
 * so a session can't be re-reviewed.
 *
 * Has three render states:
 *   1. composer (default)
 *   2. sending (composer disabled)
 *   3. sent (confirmation card with "open thread" / "back to sessions")
 */
export default function SessionFeedbackComposer({
  sessionId,
  studentProfileId,
  studentFullName,
  onFinish,
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sendMessage = useSendMessage();
  const markReviewed = useMarkSessionReviewed();

  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [sentAt, setSentAt] = useState(null);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LEN;
  const canSend =
    !!sessionId
    && !!studentProfileId
    && trimmed.length > 0
    && !tooLong
    && !sendMessage.isPending;

  function handleSubmit(e) {
    e?.preventDefault?.();
    if (!canSend) return;
    sendMessage.mutate(
      { recipientProfileId: studentProfileId, body: trimmed, sessionId },
      {
        onSuccess: () => {
          setSentAt(new Date());
          setError(null);
        },
        onError: (err) => setError(err?.message || t('feedback.sendError')),
      },
    );
  }

  function handleSkip() {
    // "Finish without feedback" is the explicit completion gesture — stamp
    // reviewed_at so the session can't be re-reviewed. The mutation is
    // idempotent (no-op when reviewed_at is already set), and we navigate
    // away regardless of success so a transient network blip doesn't strand
    // the coach on the review page.
    if (sessionId) {
      markReviewed.mutate(
        { sessionId },
        { onSettled: () => onFinish?.() },
      );
    } else {
      onFinish?.();
    }
  }

  if (sentAt) {
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
          {t('feedback.sentTitle')}
        </div>
        <p className="text-[13px] text-ink-700">{t('feedback.sentBody')}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => navigate(`/coach/messages/${studentProfileId}`)}
            className="sl-btn-primary text-[12px]"
            style={{ padding: '8px 12px' }}
          >
            {t('feedback.openThread')}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            {t('feedback.backToSessions')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sl-card p-4 space-y-3">
      <div>
        <div className="sl-label text-ink-400">{t('feedback.sectionLabel')}</div>
        <h2 className="sl-display text-[16px] text-gray-900 leading-tight mt-0.5">
          {t('feedback.coachKicker')}
          {studentFullName ? ` · ${studentFullName}` : ''}
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setError(null);
          }}
          rows={4}
          placeholder={t('feedback.placeholder')}
          aria-label={t('feedback.coachKicker')}
          className="w-full resize-y rounded-xl bg-ink-100 px-3 py-2 text-[16px] text-gray-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
        {(error || tooLong) && (
          <div role="alert" className="sl-mono text-[11px] text-danger">
            {error || t('messaging.tooLong', { n: MAX_LEN })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!canSend}
            className="sl-btn-primary text-[12px] disabled:opacity-50"
            style={{ padding: '10px 14px' }}
          >
            {sendMessage.isPending ? t('feedback.sending') : t('feedback.sendFeedback')}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            {t('feedback.finishWithoutFeedback')}
          </button>
        </div>
      </form>
    </div>
  );
}
