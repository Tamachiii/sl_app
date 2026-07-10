// Training-day helpers. Convention: 1 = Monday … 7 = Sunday.

export const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const DAY_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Long-form names — used for aria-labels where single-letter or three-letter
// abbreviations would be ambiguous to screen readers.
export const DAY_FULL_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Map JS getDay() (0=Sun … 6=Sat) → training day_number (1=Mon … 7=Sun).
export function todayDayNumber() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

// Weekday slot for a session. Prefer scheduled_date (actual calendar day) over day_number.
export function sessionDayNumber(s) {
  if (s?.scheduled_date) {
    const d = parseISODate(s.scheduled_date);
    if (d) {
      const jsDay = d.getDay();
      return jsDay === 0 ? 7 : jsDay;
    }
  }
  return s?.day_number;
}

// ─── Calendar helpers ───────────────────────────────────────────────────────
// scheduled_date is a bare YYYY-MM-DD calendar date: parse/format it in local
// time (never via Date.parse / toISOString, which shift across timezones).

export function parseISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// Monday of the calendar week containing `date` (weeks run Mon → Sun).
export function startOfWeekMonday(date) {
  const jsDay = date.getDay();
  return addDays(date, jsDay === 0 ? -6 : 1 - jsDay);
}

/**
 * Resolve two sessions competing for the same day slot: an active session
 * beats an archived one, then a pending session beats a confirmed one, and
 * on a full tie the first in program order (`a`) keeps the slot. Keeping
 * confirmation in the rule matters: a confirmed session from another training
 * week must never hide a session the student still has to do that day.
 */
export function preferSession(a, b, confirmedIds) {
  if (!a) return b ?? null;
  if (!b) return a;
  if (!!a.archived_at !== !!b.archived_at) return a.archived_at ? b : a;
  const aConf = confirmedIds.has(a.id);
  const bConf = confirmedIds.has(b.id);
  if (aConf !== bConf) return aConf ? b : a;
  return a;
}
