// @vitest-environment node
// Every text of the Parc primitives comes from the i18n dictionaries (the Parc redesign:
// French, English and German, no label left in English). See test/hardcodedScan.
import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHardcoded, formatFinding } from '../../test/hardcodedScan';

describe('the Parc primitives hard-code no text', () => {
  const scan = scanHardcoded({
    root: dirname(fileURLToPath(import.meta.url)),
    allow: { files: [], text: [] },
  });
  it('read the folder', () => expect(scan.files).toBeGreaterThan(0));
  it('finds none', () => expect(scan.findings.map(formatFinding)).toEqual([]));
  it('has no stale allow-list entry', () => expect(scan.unused).toEqual({ files: [], text: [] }));
});
