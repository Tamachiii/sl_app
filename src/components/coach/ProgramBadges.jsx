export function ActiveBadge({ t }) {
  return (
    <span
      className="sl-mono text-[10px] inline-flex items-center gap-1 px-1 rounded shrink-0"
      style={{
        background: 'color-mix(in srgb, var(--color-success) 18%, transparent)',
        color: 'var(--color-success)',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {t('coach.home.activeBadge')}
    </span>
  );
}

export function DraftBadge({ submitted, t }) {
  // The un-submitted variant uses the `text-ink-500` utility class (not an inline
  // color) so the `.dark` remap flips it and it stays legible in dark mode; the
  // submitted variant's accent is a saturated brand token that reads in both themes.
  return (
    <span
      className={`sl-mono text-[10px] inline-flex items-center gap-1 px-1 rounded shrink-0 ${submitted ? '' : 'text-ink-500'}`}
      style={{
        background: submitted
          ? 'color-mix(in srgb, var(--color-accent) 18%, transparent)'
          : 'color-mix(in srgb, var(--color-ink-400) 18%, transparent)',
        ...(submitted ? { color: 'var(--color-accent)' } : {}),
      }}
    >
      {submitted ? t('coach.home.submittedBadge') : t('coach.home.draftBadge')}
    </span>
  );
}
