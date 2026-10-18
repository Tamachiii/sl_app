import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { Button } from '../parc';

// What a coach page shows in place of its content when it has none to show.
// Two different statements, never one for the other:
//
//   CoachReadProblem  the read got no answer — it failed, or it waits for the
//                     network. Nothing is known about what it reads, so the
//                     page claims nothing and offers to ask again.
//   CoachNotFound     the read answered, and what the URL names is not there
//                     (deleted, never this coach's, a link gone stale). Asking
//                     again would answer the same: the way out is a link.
//
// `compact` is for one section of a page rather than the page.

const boxClass = (compact) =>
  `flex flex-col items-center text-center gap-4 ${compact ? 'py-6' : 'py-12'}`;

/**
 * `state` is what lib/readState.js said: 'offline' or 'failed'. `onRetry`
 * should join a request already on its way — `refetch({ cancelRefetch: false })`.
 */
export function CoachReadProblem({ state, onRetry, retrying = false, compact = false }) {
  const { t } = useI18n();
  const offline = state === 'offline';
  return (
    <div role="status" className={boxClass(compact)}>
      <div className="flex flex-col gap-1">
        <p className="pk-headline">
          {t(offline ? 'coachEditorNavErrors.read.offlineTitle' : 'coachEditorNavErrors.read.errorTitle')}
        </p>
        <p className="pk-subhead">
          {t(offline ? 'coachEditorNavErrors.read.offlineBody' : 'coachEditorNavErrors.read.errorBody')}
        </p>
      </div>
      <Button variant="on-ground" onClick={onRetry} disabled={retrying}>
        {t('coachEditorNavErrors.read.retry')}
      </Button>
    </div>
  );
}

/**
 * `to` is where the way out leads (a path, or a `To` object), in place of
 * this entry with `replace`; `onLeave` runs on the tap, for a page that must
 * forget it was open. Without `to`, the way out is a button that runs
 * `onLeave` alone.
 */
export function CoachNotFound({ title, body, to, replace = false, linkLabel, onLeave, compact = false }) {
  return (
    <div role="status" className={boxClass(compact)}>
      <div className="flex flex-col gap-1">
        <p className="pk-title">{title}</p>
        {body && <p className="pk-subhead">{body}</p>}
      </div>
      {to ? (
        <Button as={Link} to={to} replace={replace} onClick={onLeave} variant="on-ground">
          {linkLabel}
        </Button>
      ) : (
        <Button variant="on-ground" onClick={onLeave}>
          {linkLabel}
        </Button>
      )}
    </div>
  );
}
