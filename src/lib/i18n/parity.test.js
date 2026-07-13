import { describe, it, expect } from 'vitest';
import en from './en';
import fr from './fr';
import de from './de';

// Flatten a nested dictionary to a sorted list of dotted key paths.
function keys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...keys(v, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

// Guards the EN/FR/DE dictionaries against silent drift: a new EN key with no
// FR/DE translation ships a mixed-language UI (the exact debt the audit
// flagged on the logging surface). Keep the three in lockstep.
describe('i18n dictionary parity', () => {
  const enKeys = keys(en);

  it('FR has exactly the same keys as EN', () => {
    const frKeys = keys(fr);
    expect(frKeys.filter((k) => !enKeys.includes(k))).toEqual([]); // extra in FR
    expect(enKeys.filter((k) => !frKeys.includes(k))).toEqual([]); // missing in FR
  });

  it('DE has exactly the same keys as EN', () => {
    const deKeys = keys(de);
    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([]);
  });
});
