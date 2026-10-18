import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { ActionBar, Button } from '../parc';

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
 * The text where the composer would be, and its ways out in the ActionBar:
 * « Vérifier à nouveau » first when nothing is known.
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
    <>
      <div className="px-4 pb-6 md:px-8">
        <section className="rounded-group bg-surface p-4">
          <h2 className="pk-headline">
            {unverified
              ? t('coachReviewConfirmation.unverified.title')
              : t('coachReviewConfirmation.feedback.title')}
          </h2>
          <p className="pk-body mt-1.5">
            {unverified
              ? t('coachReviewConfirmation.unverified.body')
              : t('coachReviewConfirmation.feedback.body')}
          </p>
        </section>
      </div>
      <ActionBar className="sticky bottom-0 z-10 mt-auto flex-col items-stretch gap-1">
        {unverified && (
          <Button variant="primary" size="lg" onClick={onRetry} disabled={retrying}>
            {retrying
              ? t('coachReviewConfirmation.unverified.checking')
              : t('coachReviewConfirmation.unverified.retry')}
          </Button>
        )}
        {!unverified && (
          <Button variant="primary" size="lg" onClick={onFinish}>
            {t('parcReview.close')}
          </Button>
        )}
        {studentProfileId && (
          <Button variant="text" onClick={() => navigate(`/coach/messages/${studentProfileId}`)}>
            {t('parcReview.openThread')}
          </Button>
        )}
        {unverified && (
          <Button variant="text" onClick={onFinish}>
            {t('parcReview.close')}
          </Button>
        )}
      </ActionBar>
    </>
  );
}
