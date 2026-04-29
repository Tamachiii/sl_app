import { useI18n } from '../../hooks/useI18n';

const MailIcon = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      d="M3 8l7.89 5.26a2 2 0 0 0 2.22 0L21 8M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z"
    />
  </svg>
);

export default function StudentMessagingSection() {
  const { t } = useI18n();
  return (
    <div
      className="sl-card p-6 md:p-8 flex flex-col items-center text-center gap-3"
      role="region"
      aria-label={t('coach.tabs.messaging')}
    >
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{
          background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
          color: 'var(--color-accent)',
        }}
      >
        {MailIcon}
      </div>
      <div className="sl-display text-[18px] text-gray-900">{t('coach.messaging.comingSoon')}</div>
      <p className="sl-mono text-[12px] text-ink-400 max-w-md leading-relaxed">
        {t('coach.messaging.description')}
      </p>
    </div>
  );
}
