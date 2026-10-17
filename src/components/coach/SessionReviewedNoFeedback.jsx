import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { formatMessageStamp } from '../../hooks/useMessages';
import { ReviewEnd } from './SessionFeedbackSent';

/**
 * Shown at the end of SessionReview when the coach finished the review
 * without leaving feedback (`sessions.reviewed_at` set, no matching feedback
 * message). The same end as SessionFeedbackSent, without a body and without
 * the check, so the two states read differently at a glance.
 */
export default function SessionReviewedNoFeedback({ reviewedAt, studentProfileId, onFinish }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  return (
    <ReviewEnd
      tone="quiet"
      title={t('parcReview.reviewedNoFeedback')}
      body={t('feedback.reviewedNoFeedbackBody')}
      stamp={reviewedAt ? t('parcReview.reviewedAt', { when: formatMessageStamp(reviewedAt, lang) }) : null}
      onClose={onFinish}
      onOpenThread={studentProfileId ? () => navigate(`/coach/messages/${studentProfileId}`) : null}
    />
  );
}
