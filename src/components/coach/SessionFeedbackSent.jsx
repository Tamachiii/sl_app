import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { formatMessageStamp } from '../../hooks/useMessages';
import { ActionBar, Button, Icon } from '../parc';

/**
 * The end of a review that is over: what it says — a check and its title,
 * then the text — and the ActionBar with « Fermer la revue » and, when the
 * athlete is known, the conversation. Shared by the feedback just sent, the
 * feedback sent before, and a review finished without one. `tone` `done`
 * draws the blue check; `quiet` none.
 */
export function ReviewEnd({ title, body, stamp, tone = 'done', onClose, onOpenThread, children }) {
  const { t } = useI18n();
  return (
    <>
      <div className="px-4 pb-6 md:px-8">
        <section className="rounded-group bg-surface p-4">
          <h2 className="pk-headline flex items-center gap-2">
            {tone === 'done' && <Icon name="check" size={18} className="shrink-0 text-blue" />}
            {title}
          </h2>
          {body && <p className="pk-body mt-1.5 whitespace-pre-wrap">{body}</p>}
          {stamp && <p className="pk-caption mt-1.5">{stamp}</p>}
          {children}
        </section>
      </div>
      <ActionBar className="sticky bottom-0 z-10 mt-auto flex-col items-stretch gap-1">
        <Button variant="primary" size="lg" onClick={onClose}>
          {t('parcReview.close')}
        </Button>
        {onOpenThread && (
          <Button variant="text" onClick={onOpenThread}>
            {t('parcReview.openThread')}
          </Button>
        )}
      </ActionBar>
    </>
  );
}

/**
 * Shown at the end of SessionReview when a feedback message already exists
 * for this session. Replaces SessionFeedbackComposer so the coach can't
 * submit twice. The DB also enforces this via a UNIQUE partial index on
 * messages.session_id.
 */
export default function SessionFeedbackSent({ feedback, studentProfileId, onFinish }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  return (
    <ReviewEnd
      title={t('parcReview.sentAt', { when: formatMessageStamp(feedback.created_at, lang) })}
      body={feedback.body}
      onClose={onFinish}
      onOpenThread={studentProfileId ? () => navigate(`/coach/messages/${studentProfileId}`) : null}
    />
  );
}
