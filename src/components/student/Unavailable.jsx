import { useI18n } from '../../hooks/useI18n';
import { Button } from '../parc';

// Stands where content would be when its read got no answer (`readState` in
// lib/readState.js says which reads those are): what happened, and a way to
// ask again. `compact` is for one drawer rather than the page.
export default function Unavailable({ title, body, onRetry, compact = false }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className={`flex flex-col items-center gap-4 text-center ${compact ? 'py-6' : 'py-16'}`}
    >
      <div className="flex flex-col gap-1">
        <p className="pk-headline">{title}</p>
        {body && <p className="pk-subhead">{body}</p>}
      </div>
      <Button variant="on-ground" onClick={onRetry}>
        {t('trainingListOffline.retry')}
      </Button>
    </div>
  );
}
