import { describe, it, expect } from 'vitest';
import { prescriptionText } from './prescriptionText';
import { messages, lookupMessage } from './i18n';

const ctxOf = (lang) => ({ lang, t: (key, params) => lookupMessage(messages, lang, key, params) });
const fr = ctxOf('fr');
const en = ctxOf('en');

const log = (n, extra) => ({ set_number: n, target_reps: 5, target_duration_seconds: null, target_weight_kg: 20, ...extra });

describe('prescriptionText', () => {
  it('writes identical sets once, with their load, in the app’s language', () => {
    const slot = { set_logs: [1, 2, 3, 4, 5].map((n) => log(n)) };
    expect(prescriptionText(slot, fr)).toBe('5 × 5 à 20 kg');
    expect(prescriptionText(slot, en)).toBe('5 × 5 at 20 kg');
  });

  it('says bodyweight when there is no load, and writes a half kilo as the language does', () => {
    expect(prescriptionText({ set_logs: [log(1, { target_weight_kg: null }), log(2, { target_weight_kg: 0 })] }, fr)).toBe(
      '2 × 5, poids du corps',
    );
    expect(prescriptionText({ set_logs: [log(1, { target_weight_kg: 17.5 })] }, fr)).toBe('5 à 17,5 kg');
  });

  it('writes holds in seconds', () => {
    const hold = (n) => log(n, { target_reps: null, target_duration_seconds: 8, target_weight_kg: null });
    expect(prescriptionText({ set_logs: [1, 2, 3, 4, 5].map(hold) }, fr)).toBe('5 tenues de 8 s');
    expect(prescriptionText({ set_logs: [hold(1)] }, fr)).toBe('Tenue de 8 s');
  });

  it('groups sets in their order, and gives up past three groups', () => {
    const slot = { set_logs: [log(1, { target_reps: 8, target_weight_kg: 100 }), log(2, { target_reps: 8, target_weight_kg: 100 }), log(3, { target_reps: 6, target_weight_kg: 100 })] };
    expect(prescriptionText(slot, fr)).toBe('2 × 8 à 100 kg, 6 à 100 kg');
    const varied = { set_logs: [1, 2, 3, 4].map((n) => log(n, { target_reps: n })) };
    expect(prescriptionText(varied, fr)).toBe('4 séries variées');
  });

  it('falls back on the slot’s own columns, and says nothing of an empty slot', () => {
    expect(prescriptionText({ sets: 4, reps: 6, weight_kg: 25, set_logs: [] }, fr)).toBe('4 × 6 à 25 kg');
    expect(prescriptionText({ sets: 0, set_logs: [] }, fr)).toBe('');
  });
});
