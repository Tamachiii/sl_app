import { useState } from 'react';
import { formatSlotPrescription } from '../../lib/volume';
import { useI18n } from '../../hooks/useI18n';

function SlotSummary({ slot }) {
  const ex = slot.exercise;
  if (!ex) return null;
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`sl-pill shrink-0 ${
          ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
        }`}
      >
        {ex.type}
      </span>
      <span className="sl-display text-[14px] text-gray-900 truncate">{ex.name}</span>
      <span className="sl-mono text-[11px] text-ink-400 shrink-0 ml-auto">
        {formatSlotPrescription(slot)}
        {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ''}
      </span>
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
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const slots = session.exercise_slots || [];

  return (
    <div className="sl-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-ink-50 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
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
            {confirmed && (
              <>
                <span aria-hidden>·</span>
                <span style={{ color: 'var(--color-success)' }}>{t('common.doneUpper')}</span>
              </>
            )}
            {archived && (
              <>
                <span aria-hidden>·</span>
                <span style={{ color: 'var(--color-warn)' }}>{t('common.archivedUpper')}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {confirmed ? (
            <span
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          ) : archived ? (
            <span className="sl-pill" style={{ background: 'color-mix(in srgb, var(--color-warn) 15%, transparent)', color: 'var(--color-warn)' }}>
              {t('common.archived')}
            </span>
          ) : (
            <span
              className="sl-pill"
              style={{ background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)', color: 'var(--color-accent)' }}
            >
              {t('common.start')}
            </span>
          )}
          <svg
            className={`w-4 h-4 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

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
