import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';

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
  `flex flex-col items-center text-center gap-3 ${compact ? 'py-6' : 'py-12'}`;

/**
 * `state` is what lib/readState.js said: 'offline' or 'failed'. `onRetry`
 * should join a request already on its way — `refetch({ cancelRefetch: false })`.
 */
export function CoachReadProblem({ state, onRetry, retrying = false, compact = false }) {
  const { t } = useI18n();
  const offline = state === 'offline';
  return (
    <div role="status" className={boxClass(compact)}>
      <div>
        <p className="text-[14px] text-gray-900">
          {t(offline ? 'coachEditorNavErrors.read.offlineTitle' : 'coachEditorNavErrors.read.errorTitle')}
        </p>
        <p className="text-[13px] text-ink-400 mt-1">
          {t(offline ? 'coachEditorNavErrors.read.offlineBody' : 'coachEditorNavErrors.read.errorBody')}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
      >
        {t('coachEditorNavErrors.read.retry')}
      </button>
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
      <div>
        <p className="sl-display text-[18px] text-gray-900">{title}</p>
        {body && <p className="text-[13px] text-ink-400 mt-1">{body}</p>}
      </div>
      {to ? (
        <Link
          to={to}
          replace={replace}
          onClick={onLeave}
          className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200"
        >
          {linkLabel}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onLeave}
          className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200"
        >
          {linkLabel}
        </button>
      )}
    </div>
  );
}
