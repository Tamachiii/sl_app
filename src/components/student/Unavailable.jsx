import { useI18n } from '../../hooks/useI18n';

// Stands where content would be when its read got no answer (`readState` in
// lib/readState.js says which reads those are): what happened, and a way to
// ask again. `compact` is for one drawer rather than the page.
export default function Unavailable({ title, body, onRetry, compact = false }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className={`flex flex-col items-center text-center gap-3 ${compact ? 'py-6' : 'py-16'}`}
    >
      <div>
        <p className="text-sm text-gray-900">{title}</p>
        {body && <p className="text-sm text-gray-400 mt-1">{body}</p>}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="sl-pill min-h-11 px-4 bg-ink-100 text-ink-700 hover:bg-ink-200"
      >
        {t('trainingListOffline.retry')}
      </button>
    </div>
  );
}
