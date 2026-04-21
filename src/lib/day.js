// Training-day helpers. Convention: 1 = Monday … 7 = Sunday.

export const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const DAY_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Map JS getDay() (0=Sun … 6=Sat) → training day_number (1=Mon … 7=Sun).
export function todayDayNumber() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}
