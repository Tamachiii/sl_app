import { expect } from 'vitest';

// Run `fn` as a device in `timeZone` would, then put the zone back. Node
// follows process.env.TZ while it runs, in the jsdom environment and under
// fake timers alike; the first assertion fails if that ever stops being true,
// so that a zone test cannot pass for having run in the machine's own zone.
//
// `fn` may be async (a hook test that awaits its query): the zone is kept
// across its awaits and put back when its promise settles. A test file runs
// its tests one after the other, so no other test sees the zone meanwhile.
export function inTimeZone(timeZone, fn) {
  const before = process.env.TZ;
  const restore = () => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  };
  process.env.TZ = timeZone;
  let result;
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// West of Greenwich (UTC-7/-8), as far east as a zone goes (UTC+14), and the
// zone most athletes are in. A date stored as midnight UTC is the evening
// before in the first, and the afternoon of the same day in the other two.
export const ZONES = ['America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/Paris'];
