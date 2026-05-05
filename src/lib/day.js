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
    const [y, m, d] = s.scheduled_date.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d).getDay();
    return jsDay === 0 ? 7 : jsDay;
  }
  return s?.day_number;
}
