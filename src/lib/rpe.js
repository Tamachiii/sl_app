// The ratings an athlete gives a set: half steps from 6 to 10 (decision L34).
// An athlete who felt 7.5 had to say 7 or 8. The database takes 1 to 10 in
// steps of 0.5 (`set_logs.rpe numeric(3,1)`, migration
// 2026_10_16_21_rpe_half_steps_day_check); below 6 is not offered.
export const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

// A rating as the athlete reads it: "7.5" in English, "7,5" in French and
// German, "8" for a whole one. The API hands `numeric` over as a JSON number.
export function formatRpe(value, lang = 'en') {
  const n = Number(value);
  try {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

// The ratings to offer for a set rated `value`: the nine, and before them a
// rating that is not offered any more — a 1 to 5 logged before half steps, or
// sent by an older version of the app — so the set's rating is on screen and
// can be taken back like any other.
export function rpeChoices(value) {
  const current = value == null || value === '' ? null : Number(value);
  return current != null && Number.isFinite(current) && !RPE_VALUES.includes(current)
    ? [current, ...RPE_VALUES]
    : RPE_VALUES;
}
