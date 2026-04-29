import { useUnreadMessageCount } from '../../hooks/useMessages';
import { useI18n } from '../../hooks/useI18n';

/**
 * Tiny accent-tinted pill rendered next to the Messages nav tab when there
 * are unread messages addressed to the signed-in user. `variant="dot"`
 * suppresses the count and just shows a dot — used in the compact bottom
 * nav where digits would crowd the icon.
 */
export default function UnreadMessagesBadge({ variant = 'count' }) {
  const { data: count = 0 } = useUnreadMessageCount();
  const { t } = useI18n();

  if (!count) return null;

  if (variant === 'dot') {
    return (
      <span
        aria-label={t('messaging.unreadAria', { n: count })}
        className="absolute top-2 right-1/2 translate-x-3 w-2 h-2 rounded-full"
        style={{ background: 'var(--color-accent)' }}
      />
    );
  }

  const label = count > 9 ? '9+' : String(count);
  return (
    <span
      aria-label={t('messaging.unreadAria', { n: count })}
      className="sl-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ml-auto"
      style={{
        background: 'var(--color-accent)',
        color: 'var(--color-ink-900)',
      }}
    >
      {label}
    </span>
  );
}
