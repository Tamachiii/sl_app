// What the training screen works out from the block, as pure functions: the
// place of each session in it, the week's dots and their sentence, and how a
// day is said. SessionView's sessionModel is the session screen's twin.
import { addDays, isoDate, parseISODate, performedDate, startOfWeekMonday } from '../../lib/day';
import { buildDayStrip, flattenSessions } from '../../lib/sessionQueue';
import { dayName, formatDate, formatRelativeDays, pluralKey } from '../../lib/i18n/format';

// The place of every session in its block, counted as the queue counts it:
// the sessions the coach did not archive, in program order.
export function positionsOf(weeks) {
  const positions = new Map();
  let n = 0;
  for (const { session } of flattenSessions(weeks)) {
    if (!session || session.archived_at) continue;
    n += 1;
    positions.set(session.id, n);
  }
  return positions;
}

// The place of every session in its block, archived ones included: where a
// session of the history stands, which names it when it has no title.
export function placesOf(weeks) {
  const places = new Map();
  let n = 0;
  for (const { session } of flattenSessions(weeks)) {
    if (!session) continue;
    n += 1;
    places.set(session.id, n);
  }
  return places;
}

// When a session is planned for, said in a few words: « aujourd'hui »,
// « demain », « ven. 21 août » for a date, « conseillée lundi » for a weekday
// only; null when the coach set neither.
export function whenText(session, { t, lang }, today = new Date()) {
  const date = session.scheduled_date ? parseISODate(session.scheduled_date) : null;
  if (date) {
    const days = Math.round((date - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (days >= -1 && days <= 1) return formatRelativeDays(lang, days);
    return formatDate(lang, date, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const dn = session.day_number;
  if (dn >= 1 && dn <= 7) return t('parcTraining.recommendedOn', { day: dayName(lang, dn, 'long') });
  return null;
}

// The day a session was really trained: « ven. 21 août »; null when it has no
// date (confirmed before the column existed).
export function trainedOnText(session, lang) {
  const date = performedDate(session);
  return date ? formatDate(lang, date, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
}

// Finished work reads newest-first, by the day it was really trained. Sessions
// with no recorded date sink below the dated ones rather than jumping to the
// top.
export function newestTrainedFirst(a, b) {
  const da = performedDate(a);
  const db = performedDate(b);
  if (da && db) return db - da;
  if (da) return -1;
  if (db) return 1;
  return 0;
}

/**
 * The athlete's week as WeekDots draws it (design/parc/components/WeekDots),
 * from the strip the coach's roster reads too (`buildDayStrip`): `done` for a
 * day trained, `today` for a session planned today, `next` for the day of the
 * next session, nothing else — no "missed". Also how many sessions were done
 * this week, and the days of each state for the sentence.
 */
export function weekOf({ sessions, upcoming, confirmedIds, now = new Date() }) {
  const monday = startOfWeekMonday(now);
  const strip = buildDayStrip({ sessions, upcoming, confirmedIds, monday });
  const todayIso = isoDate(now);
  const nextId = upcoming[0]?.id ?? null;
  const days = strip.map((day, i) => {
    const iso = isoDate(addDays(monday, i));
    if (day.state === 'performed') return 'done';
    const open = day.state === 'planned' || day.state === 'suggested';
    if (open && iso === todayIso) return 'today';
    // A day already gone is not where the next session is: it is still next,
    // and the dots say nothing about when.
    if (open && day.session?.id === nextId && iso > todayIso) return 'next';
    return 'none';
  });
  // The sessions done this week — two on Monday are two, where the strip
  // has one dot for the day. Done is what the strip calls performed: a
  // training date in the week, or, for a session confirmed before that date
  // existed, the day it was planned for. An archived session is not counted.
  const weekDays = new Set(Array.from({ length: 7 }, (_, i) => isoDate(addDays(monday, i))));
  const confirmed = confirmedIds || new Set();
  const doneCount = (sessions || []).filter((session) => {
    if (session.archived_at) return false;
    const trained = performedDate(session);
    if (trained) return weekDays.has(isoDate(trained));
    return confirmed.has(session.id) && !!session.scheduled_date && weekDays.has(session.scheduled_date.slice(0, 10));
  }).length;
  return {
    days,
    doneCount,
    doneDays: days.flatMap((d, i) => (d === 'done' ? [i + 1] : [])),
    todayPlanned: days.includes('today'),
    nextDay: days.indexOf('next') + 1 || null,
  };
}

/**
 * The week of an athlete as WeekDots draws it, from the strip the coach's
 * roster already holds (`weekDays` of `useCoachDashboardPrograms`: `{
 * dayNumber, state }` per day): `done` for a day trained, `today` for a
 * session planned today, `next` for the next session when its day is still to
 * come, nothing else. The same shape as `weekOf`, for `weekSentence`.
 */
export function weekFromStrip(weekDays, todayDayNumber) {
  const isOpen = (day) => day.state === 'planned' || day.state === 'suggested';
  // The ring marks the next session only: the first open day of the week,
  // when it is still to come — as `weekOf` does for the athlete. A session
  // today, or one whose day has passed without it, is the next one, and a
  // later day is not.
  const head = (weekDays || []).find(isOpen);
  const days = (weekDays || []).map((day) => {
    if (day.state === 'performed') return 'done';
    if (isOpen(day) && day.dayNumber === todayDayNumber) return 'today';
    if (day === head && day.dayNumber > todayDayNumber) return 'next';
    return 'none';
  });
  return {
    days,
    doneCount: days.filter((d) => d === 'done').length,
    doneDays: days.flatMap((d, i) => (d === 'done' ? [i + 1] : [])),
    todayPlanned: days.includes('today'),
    nextDay: days.indexOf('next') + 1 || null,
  };
}

// « Cette semaine, lundi et mercredi faits, séance prévue aujourd'hui » — the
// sentence that names the week's dots for a screen reader.
export function weekSentence(week, { t, lang }) {
  const parts = [];
  if (week.doneDays.length > 0) {
    const names = week.doneDays.map((d) => dayName(lang, d, 'long'));
    let list = names.join(', ');
    try {
      list = new Intl.ListFormat(lang, { type: 'conjunction' }).format(names);
    } catch {
      // A browser without ListFormat reads the commas.
    }
    parts.push(t(pluralKey(lang, names.length, 'parcTraining.weekDone'), { days: list }));
  }
  if (week.todayPlanned) parts.push(t('parcTraining.weekToday'));
  if (week.nextDay) parts.push(t('parcTraining.weekNext', { day: dayName(lang, week.nextDay, 'long') }));
  if (parts.length === 0) parts.push(t('parcTraining.weekEmpty'));
  return t('parcTraining.weekLabel', { parts: parts.join(', ') });
}
