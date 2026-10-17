// What the training screen works out from the block, as pure functions: the
// place of each session, how a planned day and a trained day are said, the
// order of finished work, and the week's seven dots with the sentence that
// names them. StudentTraining draws what these answer; the same cases are held
// once more through the page in StudentTraining.test.jsx.
import { describe, it, expect } from 'vitest';
import { messages, lookupMessage } from '../../lib/i18n';
import { inTimeZone, ZONES } from '../../test/inTimeZone';
import {
  newestTrainedFirst,
  positionsOf,
  trainedOnText,
  weekOf,
  weekSentence,
  whenText,
} from './trainingModel';

const ctxOf = (lang) => ({ lang, t: (key, params) => lookupMessage(messages, lang, key, params) });
const en = ctxOf('en');
const fr = ctxOf('fr');

const program = { id: 'p-1', name: 'Bloc 3', sort_order: 0, is_active: true };

const session = (id, over = {}) => ({
  id,
  title: id,
  day_number: null,
  sort_order: 0,
  scheduled_date: null,
  archived_at: null,
  performed_at: null,
  ...over,
});

const week = (id, week_number, sessions) => ({ id, week_number, program, sessions });

// `sessions.performed_at` as the database writes it: the day trained, as
// midnight UTC.
const trainedOn = (iso) => `${iso}T00:00:00+00:00`;

// Wednesday 14 October 2026 at noon: the week runs from Monday 12 to Sunday 18.
// Built where it is used, so that a test inside a zone builds it in that zone.
const wednesday = (hours = 12, minutes = 0) => new Date(2026, 9, 14, hours, minutes);

describe('positionsOf', () => {
  // The number a session wears on the screen is its place in the queue: the
  // header's "session 4 of 6" and the dot of the row must be the same 4.
  it('numbers the sessions of the block in program order, across phases', () => {
    const weeks = [
      // Handed over out of order: the function sorts, it does not trust.
      week('w-2', 2, [session('c', { sort_order: 0 })]),
      week('w-1', 1, [session('b', { sort_order: 1 }), session('a', { sort_order: 0 })]),
    ];
    expect([...positionsOf(weeks)]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  // The queue counts the sessions the coach did not archive, and so does
  // every number beside it.
  it('gives an archived session no place, and does not count it', () => {
    const weeks = [
      week('w-1', 1, [
        session('a', { sort_order: 0 }),
        session('pulled', { sort_order: 1, archived_at: '2026-10-01T00:00:00Z' }),
        session('b', { sort_order: 2 }),
      ]),
    ];
    const positions = positionsOf(weeks);
    expect(positions.get('a')).toBe(1);
    expect(positions.has('pulled')).toBe(false);
    expect(positions.get('b')).toBe(2);
  });

  it('is empty for a block that has no session, or none at all', () => {
    expect(positionsOf([]).size).toBe(0);
    expect(positionsOf(undefined).size).toBe(0);
    expect(positionsOf([week('w-1', 1, [])]).size).toBe(0);
  });
});

describe('whenText', () => {
  it('says yesterday, today and tomorrow in words', () => {
    const today = wednesday();
    expect(whenText(session('a', { scheduled_date: '2026-10-13' }), en, today)).toBe('yesterday');
    expect(whenText(session('a', { scheduled_date: '2026-10-14' }), en, today)).toBe('today');
    expect(whenText(session('a', { scheduled_date: '2026-10-15' }), en, today)).toBe('tomorrow');
    expect(whenText(session('a', { scheduled_date: '2026-10-14' }), fr, today)).toBe('aujourd’hui');
  });

  it('writes any other date the coach set as a day of the calendar', () => {
    const today = wednesday();
    expect(whenText(session('a', { scheduled_date: '2026-10-16' }), en, today)).toBe('Fri, Oct 16');
    expect(whenText(session('a', { scheduled_date: '2026-10-09' }), en, today)).toBe('Fri, Oct 9');
    expect(whenText(session('a', { scheduled_date: '2026-10-16' }), fr, today)).toBe('ven. 16 oct.');
  });

  // A recommended weekday is advice, not a deadline: it is never written as
  // a date, and never as a day that passed.
  it('spells a recommended weekday out as advice', () => {
    expect(whenText(session('a', { day_number: 3 }), en, wednesday())).toBe('advised on Wednesday');
    expect(whenText(session('a', { day_number: 7 }), en, wednesday())).toBe('advised on Sunday');
    expect(whenText(session('a', { day_number: 1 }), fr, wednesday())).toBe('conseillée lundi');
  });

  it('prefers the date to the weekday when the coach set both', () => {
    const both = session('a', { scheduled_date: '2026-10-16', day_number: 1 });
    expect(whenText(both, en, wednesday())).toBe('Fri, Oct 16');
  });

  it('says nothing when the coach set neither', () => {
    for (const day_number of [null, undefined, 0, 8]) {
      expect(whenText(session('a', { day_number }), en, wednesday())).toBeNull();
    }
    // A date it cannot read is no date: the weekday speaks, or nothing does.
    expect(whenText(session('a', { scheduled_date: 'soon', day_number: 2 }), en, wednesday())).toBe(
      'advised on Tuesday',
    );
    expect(whenText(session('a', { scheduled_date: 'soon' }), en, wednesday())).toBeNull();
  });

  // `scheduled_date` is a bare calendar date, read in local time. Late in the
  // evening as at dawn, today is today — and a change of the clocks (Paris on
  // 25 October, a day of 25 hours) moves no session by a day.
  describe.each(ZONES)('%s', (zone) => {
    it('counts calendar days from today, at any hour', () => {
      inTimeZone(zone, () => {
        for (const today of [wednesday(0, 30), wednesday(23, 30)]) {
          expect(whenText(session('a', { scheduled_date: '2026-10-14' }), en, today)).toBe('today');
          expect(whenText(session('a', { scheduled_date: '2026-10-15' }), en, today)).toBe('tomorrow');
        }
      });
    });

    it('counts them across a change of the clocks', () => {
      inTimeZone(zone, () => {
        const sunday = new Date(2026, 9, 25, 23, 30);
        expect(whenText(session('a', { scheduled_date: '2026-10-24' }), en, sunday)).toBe('yesterday');
        expect(whenText(session('a', { scheduled_date: '2026-10-26' }), en, sunday)).toBe('tomorrow');
        const saturday = new Date(2026, 9, 24, 0, 30);
        expect(whenText(session('a', { scheduled_date: '2026-10-25' }), en, saturday)).toBe('tomorrow');
      });
    });
  });
});

describe('trainedOnText', () => {
  it('writes the day a session was really trained', () => {
    expect(trainedOnText(session('a', { performed_at: trainedOn('2026-08-21') }), 'en')).toBe('Fri, Aug 21');
    expect(trainedOnText(session('a', { performed_at: trainedOn('2026-08-21') }), 'fr')).toBe('ven. 21 août');
  });

  // The confirmation's day, when the row carries it, is the athlete's word.
  it('prefers the day of the confirmation', () => {
    const both = session('a', { performed_on: '2026-08-20', performed_at: trainedOn('2026-08-21') });
    expect(trainedOnText(both, 'en')).toBe('Thu, Aug 20');
  });

  // Confirmed before the column existed: no date, and none is made up.
  it('says nothing of a session without a date', () => {
    expect(trainedOnText(session('a'), 'en')).toBeNull();
  });

  // Midnight UTC, read as an instant, is the evening before west of
  // Greenwich: a Friday session would read Thursday in Los Angeles.
  it.each(ZONES)('reads the day as the day in %s', (zone) => {
    inTimeZone(zone, () => {
      expect(trainedOnText(session('a', { performed_at: trainedOn('2026-08-21') }), 'en')).toBe('Fri, Aug 21');
    });
  });
});

describe('newestTrainedFirst', () => {
  // A log has one honest order — when it happened. The old list sorted by
  // RECOMMENDED weekday, so a session done on the 18th sat above one done on
  // the 21st.
  it('orders finished sessions by the day they were trained, newest first', () => {
    const sessions = [
      session('upper1', { day_number: 1, performed_at: trainedOn('2026-08-18') }),
      session('wrist', { day_number: 5, performed_at: trainedOn('2026-08-21') }),
      session('legs', { day_number: 3, performed_at: trainedOn('2026-08-19') }),
    ];
    expect(sessions.slice().sort(newestTrainedFirst).map((s) => s.id)).toEqual(['wrist', 'legs', 'upper1']);
  });

  // Rather than jumping to the top: a session without a date is not the
  // newest, it is the one nobody knows about.
  it('sinks the sessions without a date below the dated ones, in the order they came', () => {
    const sessions = [
      session('undated-1'),
      session('old', { performed_at: trainedOn('2026-08-18') }),
      session('undated-2'),
      session('new', { performed_at: trainedOn('2026-08-21') }),
    ];
    expect(sessions.slice().sort(newestTrainedFirst).map((s) => s.id)).toEqual([
      'new',
      'old',
      'undated-1',
      'undated-2',
    ]);
  });

  it.each(ZONES)('orders two days in a row the same way in %s', (zone) => {
    inTimeZone(zone, () => {
      const sessions = [
        session('thu', { performed_at: trainedOn('2026-08-20') }),
        session('fri', { performed_on: '2026-08-21' }),
      ];
      expect(sessions.slice().sort(newestTrainedFirst).map((s) => s.id)).toEqual(['fri', 'thu']);
    });
  });
});

describe('weekOf', () => {
  const confirmedIds = (...ids) => new Set(ids);

  it('draws a day trained as done, and a session planned today as today', () => {
    const mon = session('mon', { performed_at: trainedOn('2026-10-12') });
    const tue = session('tue', { performed_at: trainedOn('2026-10-13') });
    const wed = session('wed', { scheduled_date: '2026-10-14' });
    const fri = session('fri', { day_number: 5 });
    const week = weekOf({
      sessions: [mon, tue, wed, fri],
      upcoming: [wed, fri],
      confirmedIds: confirmedIds('mon', 'tue'),
      now: wednesday(),
    });
    // Friday's session is advice for a session that is not the next one: no
    // dot of its own.
    expect(week.days).toEqual(['done', 'done', 'today', 'none', 'none', 'none', 'none']);
    expect(week.doneCount).toBe(2);
    expect(week.doneDays).toEqual([1, 2]);
    expect(week.todayPlanned).toBe(true);
    expect(week.nextDay).toBeNull();
  });

  it('rings the day of the next session when it is not today', () => {
    const mon = session('mon', { performed_at: trainedOn('2026-10-12') });
    const fri = session('fri', { day_number: 5 });
    const week = weekOf({
      sessions: [mon, fri],
      upcoming: [fri],
      confirmedIds: confirmedIds('mon'),
      now: wednesday(),
    });
    expect(week.days).toEqual(['done', 'none', 'none', 'none', 'next', 'none', 'none']);
    expect(week.nextDay).toBe(5);
    expect(week.todayPlanned).toBe(false);
  });

  // A planned day that passes is not a failure: there is no "missed" dot,
  // and a session the coach pulled leaves its day empty.
  it('has no missed day, and draws nothing for an archived session', () => {
    const next = session('next', { scheduled_date: '2026-10-16' });
    const yesterday = session('late', { scheduled_date: '2026-10-13' });
    const pulled = session('pulled', { scheduled_date: '2026-10-12', archived_at: '2026-10-10T00:00:00Z' });
    const week = weekOf({
      sessions: [next, yesterday, pulled],
      upcoming: [next, yesterday],
      confirmedIds: confirmedIds(),
      now: wednesday(),
    });
    expect(week.days).toEqual(['none', 'none', 'none', 'none', 'next', 'none', 'none']);
    expect(week.doneCount).toBe(0);
  });

  it('leaves out what was trained another week', () => {
    const lastSunday = session('sun', { performed_at: trainedOn('2026-10-11') });
    const nextMonday = session('mon', { scheduled_date: '2026-10-19' });
    const week = weekOf({
      sessions: [lastSunday, nextMonday],
      upcoming: [nextMonday],
      confirmedIds: confirmedIds('sun'),
      now: wednesday(),
    });
    expect(week.days).toEqual(['none', 'none', 'none', 'none', 'none', 'none', 'none']);
    expect(week.doneCount).toBe(0);
    expect(week.nextDay).toBeNull();
  });

  // Its own word: "how many sessions were done this week". The caption
  // beside the dots says it as "2 sessions done this week".
  it('counts the sessions done this week, not the days: two on Monday are two', () => {
    const morning = session('am', { performed_at: trainedOn('2026-10-12') });
    const evening = session('pm', { performed_at: trainedOn('2026-10-12') });
    const week = weekOf({
      sessions: [morning, evening],
      upcoming: [],
      confirmedIds: confirmedIds('am', 'pm'),
      now: wednesday(),
    });
    expect(week.days[0]).toBe('done');
    expect(week.doneDays).toEqual([1]);
    expect(week.doneCount).toBe(2);
  });

  // Monday's session, stored as midnight UTC, sat on the Sunday before in
  // Los Angeles — in last week, out of this one.
  describe.each(ZONES)('%s', (zone) => {
    it('puts a session on the day it was trained, from Monday to Sunday evening', () => {
      inTimeZone(zone, () => {
        const mon = session('mon', { performed_at: trainedOn('2026-10-12') });
        const sun = session('sun', { performed_at: trainedOn('2026-10-18') });
        const before = session('before', { performed_at: trainedOn('2026-10-11') });
        for (const now of [new Date(2026, 9, 12, 0, 30), new Date(2026, 9, 18, 23, 30)]) {
          const week = weekOf({
            sessions: [mon, sun, before],
            upcoming: [],
            confirmedIds: confirmedIds('mon', 'sun', 'before'),
            now,
          });
          expect(week.days).toEqual(['done', 'none', 'none', 'none', 'none', 'none', 'done']);
          expect(week.doneDays).toEqual([1, 7]);
        }
      });
    });

    it('rings today at any hour of it', () => {
      inTimeZone(zone, () => {
        const wed = session('wed', { scheduled_date: '2026-10-14' });
        for (const now of [wednesday(0, 30), wednesday(23, 30)]) {
          const week = weekOf({ sessions: [wed], upcoming: [wed], confirmedIds: confirmedIds(), now });
          expect(week.days[2]).toBe('today');
        }
      });
    });
  });
});

describe('weekSentence', () => {
  const week = (over) => ({ doneDays: [], todayPlanned: false, nextDay: null, ...over });

  // The dots differ by shape for the eye; a screen reader is read this.
  it('names the days done, a session today and the day of the next one', () => {
    expect(weekSentence(week({ doneDays: [1, 2], todayPlanned: true }), en)).toBe(
      'This week, Monday and Tuesday done, a session planned today',
    );
    expect(weekSentence(week({ doneDays: [2, 4], nextDay: 6 }), en)).toBe(
      'This week, Tuesday and Thursday done, next session Saturday',
    );
    expect(weekSentence(week({ doneDays: [1, 3, 5] }), en)).toBe(
      'This week, Monday, Wednesday, and Friday done',
    );
    expect(weekSentence(week({ doneDays: [1] }), en)).toBe('This week, Monday done');
  });

  it('says a week with nothing in it is empty', () => {
    expect(weekSentence(week(), en)).toBe('This week, nothing planned');
  });

  it('is said in the app’s language, with its agreement', () => {
    expect(weekSentence(week({ doneDays: [1, 3], todayPlanned: true }), fr)).toBe(
      'Cette semaine, lundi et mercredi faits, séance prévue aujourd’hui',
    );
    expect(weekSentence(week({ doneDays: [1] }), fr)).toBe('Cette semaine, lundi fait');
  });
});

describe('weekOf: the next session', () => {
  it('rings the day of the next session when it is to come, never a day already gone', () => {
    const next = session('next', { scheduled_date: '2026-10-13' });
    const later = session('later', { scheduled_date: '2026-10-16' });
    const past = weekOf({ sessions: [next], upcoming: [next], confirmedIds: new Set(), now: wednesday() });
    expect(past.days).not.toContain('next');
    expect(past.nextDay).toBeNull();
    const ahead = weekOf({ sessions: [later], upcoming: [later], confirmedIds: new Set(), now: wednesday() });
    expect(ahead.days[4]).toBe('next');
    expect(ahead.nextDay).toBe(5);
  });
});

