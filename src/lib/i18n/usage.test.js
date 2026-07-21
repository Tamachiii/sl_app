import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import en from './en';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '../..');

function keys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keys(v, path));
    else out.push(path);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Literal t('a.b.c') call sites. Keys built from a template literal
// (t(`errors.${code}`)) don't match and are covered by their own call sites'
// tests — this guard is about typos and deletions, not dynamic families.
const T_CALL = /(?<![\w.])t\(\s*'([a-zA-Z0-9_.]+)'/g;

// A missing key renders as the raw dotted path in the UI — no crash, no test
// failure, just "student.home.weekAdherence" sitting on the screen. This is
// the guard for that, and the reason a key deletion can't quietly outrun its
// call sites.
describe('i18n key usage', () => {
  const known = new Set(keys(en));
  const files = [resolve(srcDir, 'components'), resolve(srcDir, 'hooks')].flatMap(walk);

  it('every literal t() key exists in the EN dictionary', () => {
    const missing = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [, key] of text.matchAll(T_CALL)) {
        if (!known.has(key)) missing.push(`${relative(srcDir, file)} → ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('actually scanned the component tree (guard against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(40);
    const found = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(T_CALL)].map((m) => m[1]));
    expect(found).toContain('common.back');
  });
});
