// @vitest-environment node
// Every text of the athlete's screens comes from the i18n dictionaries (the Parc redesign:
// French, English and German, no label left in English). See test/hardcodedScan.
import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHardcoded, formatFinding } from '../../test/hardcodedScan';

describe('the screens of the athlete hard-code no text', () => {
  const scan = scanHardcoded({
    root: dirname(fileURLToPath(import.meta.url)),
      // « kg » is the same in English, French and German.
    allow: { files: [], text: ['kg'] },
  });
  it('read the folder', () => expect(scan.files).toBeGreaterThan(0));
  it('finds none', () => expect(scan.findings.map(formatFinding)).toEqual([]));
  it('has no stale allow-list entry', () => expect(scan.unused).toEqual({ files: [], text: [] }));
});
