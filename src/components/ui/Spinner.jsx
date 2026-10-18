import { useI18n } from '../../hooks/useI18n';

// What stands where content is being read: a ring that turns, in `blue` on
// `line-strong`, named « Chargement » for assistive technology.
export default function Spinner() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-label={t('parcFrame.loading')}
      className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-blue motion-reduce:animate-none"
    />
  );
}
