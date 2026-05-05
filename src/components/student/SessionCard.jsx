import { useState } from 'react';
import { summarizeSlotPrescription } from '../../lib/volume';
import { useI18n } from '../../hooks/useI18n';

function SlotSummary({ slot }) {
  const ex = slot.exercise;
  if (!ex) return null;
  const summary = summarizeSlotPrescription(slot);
  return (
    <div className="flex items-center gap-2.5">
      <span className="sl-display text-[14px] text-gray-900 truncate">{ex.name}</span>
      <span className="sl-mono text-[11px] text-ink-400 shrink-0 ml-auto">{summary}</span>
    </div>
  );
}

/**
 * Expandable session card showing the full exercise list and a Start button.
 * Used on the student Sessions page and above Upcoming on Home.
 */
export default function SessionCard({
  session,
  confirmed,
  archived,
  onStart,
  defaultOpen = false,
  subtitle,
  open: controlledOpen,
  onToggle,
  collapsible = true,
}) {
  const { t } = useI18n();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = collapsible ? (isControlled ? controlledOpen : uncontrolledOpen) : true;
  const toggle = () => {
    if (isControlled) onToggle?.();
    else setUncontrolledOpen((v) => !v);
  };
  const slots = session.exercise_slots || [];

  // The Start pill is an actual navigation affordance — tapping it opens
  // SessionView directly instead of just expanding the card. Only shown
  // while the card is collapsed; once expanded, the bottom CTA takes over.
  // Done / archived pills stay as labels (no action attached).
  const isStartable = collapsible && !open && !confirmed && !archived && !!onStart;
  let statusPill = null;
  if (confirmed) {
    statusPill = (
      <span
        className="sl-pill"
        style={{ background: 'color-mix(in srgb, var(--color-success) 20%, transparent)', color: 'var(--color-success)' }}
      >
        {t('common.done')}
      </span>
    );
  } else if (archived) {
    statusPill = (
      <span className="sl-pill" style={{ background: 'color-mix(in srgb, var(--color-warn) 15%, transparent)', color: 'var(--color-warn)' }}>
        {t('common.archived')}
      </span>
    );
  } else if (collapsible && !isStartable) {
    statusPill = (
      <span
        className="sl-pill"
        style={{ background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)', color: 'var(--color-accent)' }}
      >
        {t('common.start')}
      </span>
    );
  }

  const titleBlock = (
    <div className="min-w-0 flex-1">
      <p
        className={`sl-display text-[17px] truncate ${
          archived ? 'text-ink-400' : 'text-gray-900'
        }`}
      >
        {session.title || `Session ${session.sort_order + 1}`}
      </p>
      <p className="sl-mono text-[11px] text-ink-400 mt-0.5 flex items-center gap-1.5">
        {subtitle && <span>{subtitle}</span>}
        {subtitle && <span aria-hidden>·</span>}
        <span>
          {slots.length} {t('common.ex')}
        </span>
      </p>
    </div>
  );

  const trailingBlock = (
    <div className="flex items-center gap-2 shrink-0">
      {statusPill}
      {collapsible && (
        <svg
          className={`w-4 h-4 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      )}
    </div>
  );

  return (
    <div className="sl-card overflow-hidden">
      {collapsible ? (
        <div className="w-full flex items-stretch hover:bg-ink-50 transition-colors">
          <button
            className="flex-1 min-w-0 flex items-center justify-between gap-3 px-4 py-3.5 text-left"
            onClick={toggle}
            aria-expanded={open}
          >
            {titleBlock}
            {trailingBlock}
          </button>
          {isStartable && (
            <button
              type="button"
              onClick={onStart}
              aria-label={t('common.startSession')}
              className="shrink-0 self-stretch flex items-center px-3 sl-pill"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
                color: 'var(--color-accent)',
                borderRadius: 0,
              }}
            >
              {t('common.start')}
            </button>
          )}
        </div>
      ) : (
        <div className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left">
          {titleBlock}
          {trailingBlock}
        </div>
      )}

      {open && (
        <div className="border-t border-ink-100">
          {slots.length === 0 ? (
            <p className="px-4 py-3 sl-mono text-[11px] text-ink-400">{t('student.sessions.noExercises')}</p>
          ) : (
            <div className="px-4 py-3 space-y-2">
              {slots.map((slot) => (
                <SlotSummary key={slot.id} slot={slot} />
              ))}
            </div>
          )}
          {!archived && (
            <div className="px-4 pb-3">
              <button
                onClick={onStart}
                className="sl-btn-primary w-full text-[13px]"
                style={{ padding: '10px 16px' }}
              >
                {confirmed ? t('common.reviewSession') : t('common.startSession')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
