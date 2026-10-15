import { useId, useState } from 'react';
import Dialog from '../ui/Dialog';
import DecimalInput from '../ui/DecimalInput';
import { useI18n } from '../../hooks/useI18n';
import { useBodyweightLogs, useLogBodyweight } from '../../hooks/useBodyweight';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { parseISODate } from '../../lib/day';
import { decimalText, parseDecimalInput } from '../../lib/number';

// What a bodyweight may be: the "between 1 and 500 kg" of the copy, and what
// `bodyweight_logs.weight_kg` takes — a numeric(5,2) under 500, so 500 itself
// is refused and 499.99 is the last value in.
const BODYWEIGHT_RULES = { min: 1, max: 499.99, allowEmpty: false };

function LogDialog({ open, onClose, current }) {
  const { t } = useI18n();
  const log = useLogBodyweight();
  const errId = useId();
  const [value, setValue] = useState(decimalText(current));
  const [err, setErr] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    // "82,5" is 82.5 whatever the language of the browser (P31): a number
    // field read it as 825 in an English Chromium, and saved it.
    const parsed = parseDecimalInput(value, BODYWEIGHT_RULES);
    if (!parsed.ok) {
      setErr(t('student.profile.bodyweight.invalid'));
      return;
    }
    log.mutate(
      { weightKg: Math.round(parsed.value * 100) / 100 },
      { onSuccess: () => onClose(), onError: () => setErr(t('errors.generic')) }
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('student.profile.bodyweight.logTitle')}>
      {/* noValidate: the field's `pattern` would have the browser refuse the
          submit with its own bubble, and the alert below would never show. */}
      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <label className="block">
          <span className="sl-label text-ink-400 block mb-1.5">
            {t('student.profile.bodyweight.weightLabel')}
          </span>
          <DecimalInput
            {...BODYWEIGHT_RULES}
            value={value}
            onChange={(e) => { setValue(e.target.value); setErr(''); }}
            // Marked by a refused weight, not by a save that failed.
            invalid={!!err && !parseDecimalInput(value, BODYWEIGHT_RULES).ok}
            aria-describedby={err ? errId : undefined}
            autoFocus
          />
        </label>
        {err && <p id={errId} role="alert" className="sl-mono text-[11px] text-danger">{err}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={log.isPending}
            className="sl-btn-primary flex-1 text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {log.isPending ? t('common.saving') : t('common.save')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center"
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function BodyweightCard() {
  const { t } = useI18n();
  const isOnline = useOnlineStatus();
  const { data: logs = [] } = useBodyweightLogs();
  const [dialogOpen, setDialogOpen] = useState(false);

  const latest = logs[0] || null;
  // Compact trend: delta from the previous entry, so a student sees direction.
  const prev = logs[1] || null;
  const delta = latest && prev ? latest.weight_kg - prev.weight_kg : null;

  return (
    <section aria-labelledby="profile-bodyweight-heading" className="space-y-2">
      <h2 id="profile-bodyweight-heading" className="sl-label text-ink-400">
        {t('student.profile.bodyweight.title')}
      </h2>
      <div className="sl-card p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {latest ? (
            <>
              <span className="sl-display text-[24px] text-gray-900 tabular-nums">
                {latest.weight_kg} <span className="text-[14px] text-ink-400">kg</span>
              </span>
              <div className="sl-mono text-[11px] text-ink-400 mt-0.5">
                {t('student.profile.bodyweight.on', {
                  // logged_on is a bare YYYY-MM-DD — parse in LOCAL time
                  // (new Date(str) is UTC midnight and shifts a day).
                  date: (parseISODate(latest.logged_on) ?? new Date()).toLocaleDateString(),
                })}
                {delta != null && Math.abs(delta) >= 0.05 && (
                  <span className="ml-2">
                    {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)} kg
                  </span>
                )}
              </div>
            </>
          ) : (
            <span className="sl-mono text-[12px] text-ink-400">
              {t('student.profile.bodyweight.empty')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={!isOnline}
          title={!isOnline ? t('common.offlineAction') : undefined}
          className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 shrink-0 disabled:opacity-50"
        >
          {t('student.profile.bodyweight.log')}
        </button>
      </div>
      {dialogOpen && (
        <LogDialog open onClose={() => setDialogOpen(false)} current={latest?.weight_kg ?? null} />
      )}
    </section>
  );
}
