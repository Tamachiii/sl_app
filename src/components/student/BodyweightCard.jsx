import { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useBodyweightLogs, useLogBodyweight } from '../../hooks/useBodyweight';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { daysSince } from '../../lib/lastPerformance';
import { parseISODate } from '../../lib/day';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { formatDate, formatNumber, formatRelativeDays, pluralKey } from '../../lib/i18n/format';
import { Button, NumberField, Sheet } from '../parc';
import { BODYWEIGHT_HEADING_ID } from './PersonalRecords';

const BODYWEIGHT_RULES = { min: 1, max: 499.99, allowEmpty: false };

// The weigh-ins the line and the change are drawn from: the last six weeks.
const WINDOW_DAYS = 42;

function LogSheet({ open, onClose, current }) {
  const { t } = useI18n();
  const log = useLogBodyweight();
  const [value, setValue] = useState(decimalText(current));
  // A refused weight is the field's error; a save that failed is not the
  // weight's fault and is said under the buttons, the field left valid.
  const [err, setErr] = useState('');
  const [saveErr, setSaveErr] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    setSaveErr('');
    const parsed = parseDecimalInput(value, BODYWEIGHT_RULES);
    if (!parsed.ok) {
      setErr(t('student.profile.bodyweight.invalid'));
      return;
    }
    log.mutate(
      { weightKg: Math.round(parsed.value * 100) / 100 },
      { onSuccess: () => onClose(), onError: () => setSaveErr(t('errors.generic')) }
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('parcStats.bwLogTitle')}>
      {/* noValidate: the field's `pattern` would have the browser refuse the
          submit with its own bubble, and the message below would never show. */}
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <NumberField
          {...BODYWEIGHT_RULES}
          size="lg"
          label={t('parcStats.bwField')}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setErr('');
            setSaveErr('');
          }}
          error={err || undefined}
          autoFocus
        />
        {saveErr && (
          <p role="alert" className="text-[13px] leading-[1.35] text-red">
            {saveErr}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Button type="submit" variant="primary" size="lg" disabled={log.isPending}>
            {log.isPending ? t('common.saving') : t('parcStats.bwSave')}
          </Button>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

// The weigh-ins of the window as a line: oldest at the left, the last one a
// dot. Decorative — the figure and the sentence above say it in words.
function Sparkline({ points }) {
  if (points.length < 2) return null;
  const W = 326;
  const H = 64;
  const PAD = 6;
  const days = points.map((p) => p.day);
  const weights = points.map((p) => p.kg);
  const first = Math.min(...days);
  const last = Math.max(...days);
  const lo = Math.min(...weights);
  const hi = Math.max(...weights);
  const x = (d) => (last === first ? W / 2 : PAD + ((d - first) / (last - first)) * (W - 2 * PAD));
  const y = (kg) => (hi === lo ? H / 2 : PAD + ((hi - kg) / (hi - lo)) * (H - 2 * PAD));
  const coords = points.map((p) => `${x(p.day)},${y(p.kg)}`).join(' ');
  const end = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 block h-auto w-full" aria-hidden="true" focusable="false">
      <polyline points={coords} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(end.day)} cy={y(end.kg)} r="4" fill="var(--ink)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

/**
 * The athlete's bodyweight (design/parc/screens/Stats.dc.html, « Poids de
 * corps »): the last weigh-in in large digits, the change over the last six
 * weeks and when it was weighed, the line of those weeks, and « Saisir mon
 * poids », which opens a sheet. Logging is online-only.
 */
export default function BodyweightCard() {
  const { t, lang } = useI18n();
  const isOnline = useOnlineStatus();
  const { data: logs = [] } = useBodyweightLogs();
  const [sheetOpen, setSheetOpen] = useState(false);

  const latest = logs[0] || null;
  const latestDate = latest ? parseISODate(latest.logged_on) : null;
  const windowLogs = latestDate
    ? logs
        .map((l) => ({ date: parseISODate(l.logged_on), kg: Number(l.weight_kg) }))
        .filter((l) => l.date && (latestDate - l.date) / 86400000 <= WINDOW_DAYS)
        .map((l) => ({ ...l, day: Math.round(l.date.getTime() / 86400000) }))
        .reverse()
    : [];
  const oldest = windowLogs[0];
  const span = oldest && latestDate ? Math.round((latestDate - oldest.date) / 86400000) : 0;
  const weeks = Math.max(1, Math.round(span / 7));
  const delta = windowLogs.length > 1 ? Number(latest.weight_kg) - oldest.kg : null;
  // Days counted between local midnights: `logged_on` is a bare date, which
  // `new Date()` would read as midnight UTC — the evening before, west of it.
  const ago = latestDate ? daysSince(latestDate) : null;
  const when =
    ago == null
      ? null
      : ago <= 6
        ? formatRelativeDays(lang, -ago)
        : formatDate(lang, latestDate, { day: 'numeric', month: 'long' });
  const facts = [
    delta != null && Math.abs(delta) >= 0.05
      ? t(pluralKey(lang, weeks, 'parcStats.bwDelta'), {
          delta: formatNumber(lang, delta, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
          n: formatNumber(lang, weeks),
        })
      : null,
    when ? t('parcStats.bwWhen', { when }) : null,
  ].filter(Boolean);

  return (
    <section aria-labelledby={BODYWEIGHT_HEADING_ID} className="rounded-group bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id={BODYWEIGHT_HEADING_ID} className="pk-headline">
          {t('parcStats.bodyweight')}
        </h2>
        <Button variant="text" onClick={() => setSheetOpen(true)} disabled={!isOnline}>
          {t('parcStats.bwLog')}
        </Button>
      </div>
      {!isOnline && <p className="pk-caption">{t('parcStats.bwOffline')}</p>}
      {latest ? (
        <>
          <p className="mt-2 flex items-baseline gap-1.5">
            <span className="pk-numeral-lg pk-condensed">{formatNumber(lang, Number(latest.weight_kg))}</span>
            <span className="pk-subhead">kg</span>
          </p>
          {facts.length > 0 && <p className="pk-caption mt-1">{facts.join(', ')}</p>}
          <Sparkline points={windowLogs} />
        </>
      ) : (
        <p className="pk-caption mt-2">{t('parcStats.bwEmpty')}</p>
      )}
      {sheetOpen && (
        <LogSheet open onClose={() => setSheetOpen(false)} current={latest?.weight_kg ?? null} />
      )}
    </section>
  );
}
