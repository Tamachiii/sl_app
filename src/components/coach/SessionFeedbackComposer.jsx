import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useSendMessage } from '../../hooks/useMessages';
import { useMarkSessionReviewed } from '../../hooks/useSession';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { ActionBar, Button, ConfirmSheet } from '../parc';
import { clearFeedbackDraft, readFeedbackDraft, writeFeedbackDraft } from '../../lib/feedbackDraft';
import { ReviewEnd } from './SessionFeedbackSent';

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
 *   1. composer (default): « Ton retour à Léa » and its field, « Envoyer le
 *      retour » and « Terminer sans retour » in the ActionBar
 *      (design/parc/screens/Revue.dc.html)
 *   2. sending (composer disabled)
 *   3. sent (« Retour envoyé », with the conversation and « Fermer la revue »)
 *
 * What is typed is a draft of THIS session, kept on the device as it is typed
 * (lib/feedbackDraft) and read back when the composer mounts: leaving the
 * page, a reload, or a read that takes the composer off screen for a while do
 * not lose it. It goes when it is sent, when it is emptied, and when the coach
 * finishes without sending it — which, with text in the box, asks first: the
 * review is one-shot, and what was typed would be gone for good.
 */
export default function SessionFeedbackComposer({
  sessionId,
  studentProfileId,
  studentFullName,
  onFinish,
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const formId = useId();
  const fieldId = useId();
  const sendMessage = useSendMessage();
  const markReviewed = useMarkSessionReviewed();

  // Same gate as MessageComposer: useSendMessage (and useMarkSessionReviewed)
  // are not offline-registered, so an offline submit would hang on
  // "Sending…" forever and a reload would silently drop the feedback.
  const isOnline = useOnlineStatus();

  // Read once: the review page mounts one composer per session (its `key`).
  const [body, setBody] = useState(() => readFeedbackDraft(sessionId));
  const [error, setError] = useState(null);
  const [sentAt, setSentAt] = useState(null);
  const [askingToFinish, setAskingToFinish] = useState(false);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LEN;
  const canSend =
    !!sessionId
    && !!studentProfileId
    && trimmed.length > 0
    && !tooLong
    && !sendMessage.isPending
    && isOnline;

  function handleSubmit(e) {
    e?.preventDefault?.();
    if (!canSend) return;
    sendMessage.mutate(
      { recipientProfileId: studentProfileId, body: trimmed, sessionId },
      {
        onSuccess: () => {
          clearFeedbackDraft(sessionId);
          setSentAt(new Date());
          setError(null);
        },
        onError: (err) => setError(err?.message || t('feedback.sendError')),
      },
    );
  }

  function handleChange(value) {
    setBody(value);
    setError(null);
    // Blank text is no draft: writeFeedbackDraft removes the key for it.
    writeFeedbackDraft(sessionId, value);
  }

  function finish() {
    // "Finish without feedback" is the explicit completion gesture — stamp
    // reviewed_at so the session can't be re-reviewed. The mutation is
    // idempotent (no-op when reviewed_at is already set), and we navigate
    // away regardless of success so a transient network blip doesn't strand
    // the coach on the review page.
    if (!isOnline) return;
    clearFeedbackDraft(sessionId);
    if (sessionId) {
      markReviewed.mutate(
        { sessionId },
        { onSettled: () => onFinish?.() },
      );
    } else {
      onFinish?.();
    }
  }

  // The composer's "Finish without feedback". With nothing typed it finishes
  // at once; with a draft it asks, and Cancel leaves the text where it is.
  function handleFinishWithoutFeedback() {
    if (!isOnline) return;
    if (trimmed.length > 0) {
      setAskingToFinish(true);
      return;
    }
    finish();
  }

  if (sentAt) {
    return (
      <ReviewEnd
        title={t('parcReview.sentTitle')}
        body={t('parcReview.sentBody')}
        onClose={finish}
        onOpenThread={() => navigate(`/coach/messages/${studentProfileId}`)}
      />
    );
  }

  return (
    <>
      <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-2.5 px-4 pb-6 md:px-8">
        <label htmlFor={fieldId} className="pk-headline">
          {studentFullName ? t('parcReview.feedbackTo', { name: studentFullName }) : t('parcReview.feedback')}
        </label>
        <textarea
          id={fieldId}
          value={body}
          onChange={(e) => handleChange(e.target.value)}
          rows={4}
          placeholder={t('parcReview.placeholder')}
          aria-invalid={tooLong || undefined}
          className="pk-field block min-h-26 resize-y py-2.5 leading-[1.45]"
        />
        {(error || tooLong) && (
          <p role="alert" className="text-[13px] leading-[1.35] text-red">
            {error || t('messaging.tooLong', { n: MAX_LEN })}
          </p>
        )}
        {!isOnline && (
          <p role="status" className="pk-caption">
            {t('messaging.offline')}
          </p>
        )}
      </form>

      <ActionBar className="sticky bottom-0 z-10 mt-auto flex-col items-stretch gap-1">
        <Button type="submit" form={formId} variant="primary" size="lg" disabled={!canSend}>
          {sendMessage.isPending ? t('feedback.sending') : t('parcReview.send')}
        </Button>
        <Button variant="text" onClick={handleFinishWithoutFeedback} disabled={!isOnline}>
          {t('parcReview.finishWithout')}
        </Button>
      </ActionBar>

      <ConfirmSheet
        open={askingToFinish}
        onClose={() => setAskingToFinish(false)}
        onConfirm={finish}
        title={t('coachReviewComposerRoster.finish.confirmTitle')}
        message={t('coachReviewComposerRoster.finish.confirmMessage')}
        confirmText={t('coachReviewComposerRoster.finish.confirmAction')}
      />
    </>
  );
}
