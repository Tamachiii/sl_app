// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXT_ATTRIBUTES, formatFinding, scanHardcoded, scanSource } from './hardcodedScan';

// What one source reports, as lines without the file name.
const lines = (code, options) => scanSource(code, 'Fixture.jsx', options).map(formatFinding);

describe('hardcodedScan: what counts as hard-coded text', () => {
  it('JSX text', () => {
    expect(lines('const a = <p>Skip set</p>;')).toEqual(['1 text "Skip set"']);
  });

  it('reports where the first word is and collapses the whitespace', () => {
    const code = [
      'const a = (',
      '  <p className="sl-label">',
      '    Your coach programs the work.',
      '    You log every set.',
      '  </p>',
      ');',
    ].join('\n');
    expect(lines(code)).toEqual(['3 text "Your coach programs the work. You log every set."']);
    expect(scanSource(code)).toEqual([
      { line: 3, column: 4, kind: 'text', text: 'Your coach programs the work. You log every set.' },
    ]);
  });

  it('text around an expression, each side on its own', () => {
    expect(lines('const a = <p>{done} of {total} sets</p>;')).toEqual(['1 text "of"', '1 text "sets"']);
  });

  it('accented and non-Latin letters are letters', () => {
    expect(lines('const a = <p>Séance terminée</p>;')).toEqual(['1 text "Séance terminée"']);
    expect(lines('const a = <p>&Uuml;bung</p>;')).toEqual(['1 text "Übung"']);
    expect(lines('const a = <p>完了</p>;')).toEqual(['1 text "完了"']);
  });

  it('a string rendered as a child, through ?: && || ?? + and arrays', () => {
    expect(lines(`const a = <b>{'Done'}</b>;`)).toEqual(['1 text "Done"']);
    expect(lines(`const a = <b>{done ? 'Done' : 'Skip'}</b>;`)).toEqual(['1 text "Done"', '1 text "Skip"']);
    expect(lines(`const a = <b>{failed && 'Failed'}</b>;`)).toEqual(['1 text "Failed"']);
    expect(lines(`const a = <b>{name || 'Untitled'}</b>;`)).toEqual(['1 text "Untitled"']);
    expect(lines(`const a = <b>{name ?? 'Untitled'}</b>;`)).toEqual(['1 text "Untitled"']);
    expect(lines(`const a = <b>{'Set ' + n}</b>;`)).toEqual(['1 text "Set"']);
    expect(lines(`const a = <b>{[count, ' attempts']}</b>;`)).toEqual(['1 text "attempts"']);
    expect(lines(`const a = <>{busy ? 'Saving…' : open ? 'Save goal' : null}</>;`)).toEqual([
      '1 text "Saving…"',
      '1 text "Save goal"',
    ]);
  });

  it('the English plural "s"', () => {
    expect(lines(`const a = <b>{n} attempt{n === 1 ? '' : 's'}</b>;`)).toEqual([
      '1 text "attempt"',
      '1 text "s"',
    ]);
  });

  it('a template literal with fixed words, and the strings inside its holes', () => {
    expect(lines('const a = <b>{`${n} sets`}</b>;')).toEqual(['1 text "${…} sets"']);
    expect(lines('const a = <b>{`Session ${index} of ${total}`}</b>;')).toEqual([
      '1 text "Session ${…} of ${…}"',
    ]);
    expect(lines("const a = <b>{`${n} ${n === 1 ? 'set' : 'sets'}`}</b>;")).toEqual([
      '1 text "set"',
      '1 text "sets"',
    ]);
  });

  it('aria-label and the other attributes a person reads or hears', () => {
    const code = `const a = (
      <form aria-label="Log a set" aria-description="Opens the editor" aria-roledescription="slide">
        <input placeholder="Note for your coach…" title="Notes" aria-valuetext="Half" aria-placeholder="Reps" />
        <img alt="Session photo" />
      </form>
    );`;
    expect(lines(code)).toEqual([
      '2 aria-label "Log a set"',
      '2 aria-description "Opens the editor"',
      '2 aria-roledescription "slide"',
      '3 placeholder "Note for your coach…"',
      '3 title "Notes"',
      '3 aria-valuetext "Half"',
      '3 aria-placeholder "Reps"',
      '4 alt "Session photo"',
    ]);
  });

  it('an attribute value built by an expression', () => {
    expect(lines(`const a = <button aria-label={open ? 'Close' : 'Open'} />;`)).toEqual([
      '1 aria-label "Close"',
      '1 aria-label "Open"',
    ]);
    expect(lines('const a = <button aria-label={`RPE ${rpe}, tap to change`} />;')).toEqual([
      '1 aria-label "RPE ${…}, tap to change"',
    ]);
    expect(lines(`const a = <button aria-label={'Play'} />;`)).toEqual(['1 aria-label "Play"']);
  });

  it('text props of shared components: the plain names and camelCase props ending in one', () => {
    const code = `const a = (
      <>
        <Dialog title="Adopt swap" confirmLabel="Adopt" cancelText="Cancel" />
        <EmptyState message="No program yet for this athlete." emptyTitle="Nothing here" />
        <Field label="sets" hint="Per side" description="Optional" ariaLabel="Sets" />
      </>
    );`;
    expect(lines(code)).toEqual([
      '3 title "Adopt swap"',
      '3 confirmLabel "Adopt"',
      '3 cancelText "Cancel"',
      '4 message "No program yet for this athlete."',
      '4 emptyTitle "Nothing here"',
      '5 label "sets"',
      '5 hint "Per side"',
      '5 description "Optional"',
      '5 ariaLabel "Sets"',
    ]);
  });

  it('the attribute list can be replaced', () => {
    const code = 'const a = <Tab label="Stats" caption="Weekly" aria-label="Tabs" />;';
    expect(lines(code, { attributes: ['caption'] })).toEqual(['1 caption "Weekly"']);
    expect(TEXT_ATTRIBUTES).toContain('aria-label');
  });
});

describe('hardcodedScan: what does not count', () => {
  it('a translated screen', () => {
    const code = `
      export default function CheckIn({ hurt, name, count }) {
        const { t } = useI18n();
        return (
          <section aria-label={t('checkin.title')} className="sl-card p-4" data-testid="checkin">
            <h2 id="checkin-title">{t('checkin.greeting', { name })}</h2>
            <p>{hurt ? t('checkin.pain.yes') : t('checkin.pain.no')}</p>
            <span>{count}</span>
            <button type="button" role="switch" aria-pressed="true" onClick={() => save('pain')}>
              {t('common.save')}
            </button>
          </section>
        );
      }`;
    expect(lines(code)).toEqual([]);
  });

  it('text without a letter: separators, numbers, symbols, entities', () => {
    const code = `const a = (
      <p>
        <span>·</span><span>—</span><span>12</span><span>×</span><span>✓</span><span>→</span>
        <span>&nbsp;</span><span>&middot;</span><span>{count} / {total}</span><span>100 %</span>
        <span>{' · '}</span><span>{\`\${a} · \${b}\`}</span><span>{'+ '}{n}</span>
      </p>
    );`;
    expect(lines(code)).toEqual([]);
  });

  it('attributes that are not text', () => {
    const code = `const a = (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M5 13l4 4L19 7" strokeLinecap="round" />
        <label htmlFor="weight" aria-labelledby="weight-title" aria-describedby="weight-hint" />
        <input id="weight" name="weight" type="text" inputMode="decimal" autoComplete="off" value="pull" />
        <a href="/student" target="_blank" rel="noreferrer" aria-current="page" data-kind="link" key="home" />
      </svg>
    );`;
    expect(lines(code)).toEqual([]);
  });

  it('strings that are compared, passed to a function or kept in a variable', () => {
    const code = `
      const label = done ? 'Done' : 'Skip';
      const TABS = [{ label: 'Stats' }];
      pushToast('Could not save');
      const a = (
        <b style={{ color: 'red' }} className={kind === 'pull' ? 'text-pull' : 'text-push'}>
          {kind === 'pull' ? <Pull /> : <Push />}
          {label}
          {format(date, 'short')}
          {TABS.map((tab) => tab.label)}
          {/* a comment */}
        </b>
      );`;
    expect(lines(code)).toEqual([]);
  });

  it('but the JSX inside a branch or a callback is still read', () => {
    const code = `const a = (
      <ul>
        {open ? <li>Open</li> : null}
        {items.map((item) => <li key={item.id} title="Row">{item.name} done</li>)}
      </ul>
    );`;
    expect(lines(code)).toEqual(['3 text "Open"', '4 title "Row"', '4 text "done"']);
  });
});

describe('hardcodedScan: a file is read or the scan stops', () => {
  it('a file that does not parse throws, with its name and line', () => {
    expect(() => scanSource('const a = <p>Fine</p>;\nconst b = ;\n', 'coach/Broken.jsx')).toThrow(
      /^hardcodedScan: cannot read coach\/Broken\.jsx:2 — Parsing error/,
    );
    expect(() => scanSource('const a = <div>', 'Open.jsx')).toThrow(/cannot read Open\.jsx:\d+ — Parsing error/);
  });

  it('an eslint-disable comment hides nothing', () => {
    const code = `/* eslint-disable */
      // eslint-disable-next-line
      const a = <p>Hello</p>; // eslint-disable-line
      /* eslint hardcoded/text: "off" */`;
    expect(lines(code)).toEqual(['3 text "Hello"']);
  });

  it('modern syntax of the code base parses', () => {
    const code = `
      import { lazy } from 'react';
      const View = lazy(() => import('./View'));
      export default function A({ rows, ...rest }) {
        const first = rows?.[0]?.name ?? null;
        const big = 1_000n;
        return <View {...rest} first={first} big={big}>{rows.at(-1)?.name}</View>;
      }`;
    expect(lines(code)).toEqual([]);
  });
});

describe('hardcodedScan: a folder against an allow-list', () => {
  let root;

  const write = (path, content) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeAll(() => {
    // Outside the working directory on purpose: the scan must not depend on
    // where the folder is.
    root = mkdtempSync(join(tmpdir(), 'hardcoded-scan-'));
    write(
      'SetRow.jsx',
      `export default function SetRow({ weight, onSkip }) {
  return (
    <div>
      <span>{weight} kg</span>
      <span>RPE</span>
      <button aria-label="Remove extra set" onClick={onSkip}>Skip</button>
    </div>
  );
}
`,
    );
    write(
      'Translated.jsx',
      `export default function Translated({ t }) {
  return <p aria-label={t('a.b')}>{t('a.c')}</p>;
}
`,
    );
    write(
      'StudentProgramAuthor.jsx',
      `export default function Author() {
  return <h1 title="Draft">Draft a program</h1>;
}
`,
    );
    write('dialogs/nested/Adopt.jsx', 'export default () => <Dialog title="Adopt swap">1RM</Dialog>;\n');
    write('helpers.js', "export const KIND = 'pull';\nexport const el = <i>From a .js file</i>;\n");
    // Not source: skipped.
    write('SetRow.test.jsx', "it('renders', () => render(<p>Text inside a test</p>));\n");
    write('helpers.test.js', "it('x', () => render(<p>Also a test</p>));\n");
    write('notes.md', '<p>Markdown is not scanned</p>\n');
    write('styles.css', '.a::after { content: "Not scanned"; }\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads every source file below the root, in path order, tests excluded', () => {
    const scan = scanHardcoded({ root });
    expect(scan.files).toBe(5);
    expect(scan.findings.map(formatFinding)).toEqual([
      'SetRow.jsx:4 text "kg"',
      'SetRow.jsx:5 text "RPE"',
      'SetRow.jsx:6 aria-label "Remove extra set"',
      'SetRow.jsx:6 text "Skip"',
      'StudentProgramAuthor.jsx:2 title "Draft"',
      'StudentProgramAuthor.jsx:2 text "Draft a program"',
      'dialogs/nested/Adopt.jsx:1 title "Adopt swap"',
      'dialogs/nested/Adopt.jsx:1 text "1RM"',
      'helpers.js:2 text "From a .js file"',
    ]);
    expect(scan.unused).toEqual({ files: [], text: [] });
  });

  it('a finding carries what a test needs to point at it', () => {
    const [first] = scanHardcoded({ root }).findings;
    // 1-based line, 0-based column of the first word (ESLint's convention).
    expect(first).toEqual({ file: 'SetRow.jsx', line: 4, column: 21, kind: 'text', text: 'kg' });
    const label = scanHardcoded({ root }).findings[2];
    expect(label).toMatchObject({ kind: 'attribute', attribute: 'aria-label', text: 'Remove extra set' });
  });

  it('an allow-listed file is exempt as a whole, by its path from the root', () => {
    const scan = scanHardcoded({
      root,
      allow: { files: ['StudentProgramAuthor.jsx', 'dialogs/nested/Adopt.jsx'] },
    });
    expect(scan.files).toBe(5);
    expect(scan.findings.map((f) => f.file)).toEqual([
      'SetRow.jsx',
      'SetRow.jsx',
      'SetRow.jsx',
      'SetRow.jsx',
      'helpers.js',
    ]);
    expect(scan.unused).toEqual({ files: [], text: [] });
  });

  it('an allow-listed text is accepted in every file, as a string or a pattern', () => {
    const scan = scanHardcoded({ root, allow: { text: ['kg', 'RPE', /^\d+RM$/g] } });
    expect(scan.findings.map(formatFinding)).toEqual([
      'SetRow.jsx:6 aria-label "Remove extra set"',
      'SetRow.jsx:6 text "Skip"',
      'StudentProgramAuthor.jsx:2 title "Draft"',
      'StudentProgramAuthor.jsx:2 text "Draft a program"',
      'dialogs/nested/Adopt.jsx:1 title "Adopt swap"',
      'helpers.js:2 text "From a .js file"',
    ]);
    expect(scan.unused).toEqual({ files: [], text: [] });
  });

  it('a string entry is the whole text, not a part of it', () => {
    const scan = scanHardcoded({ root, allow: { text: ['Draft'] } });
    expect(scan.findings.map(formatFinding)).toContain('StudentProgramAuthor.jsx:2 text "Draft a program"');
    expect(scan.findings.map(formatFinding)).not.toContain('StudentProgramAuthor.jsx:2 title "Draft"');
  });

  it('the folder can end clean, which is what a sweep test expects', () => {
    const scan = scanHardcoded({
      root,
      allow: {
        files: ['StudentProgramAuthor.jsx'],
        text: ['kg', 'RPE', '1RM', 'Remove extra set', 'Skip', 'Adopt swap', 'From a .js file'],
      },
    });
    expect(scan.findings).toEqual([]);
    expect(scan.unused).toEqual({ files: [], text: [] });
  });

  it('reports the allow-list entries that exempt nothing, so the list only shrinks', () => {
    const scan = scanHardcoded({
      root,
      allow: {
        files: ['StudentProgramAuthor.jsx', 'Translated.jsx', 'Deleted.jsx'],
        text: ['kg', 'lbs', /^Week \d+$/],
      },
    });
    expect(scan.unused).toEqual({
      // No literal left in it; no such file.
      files: ['Translated.jsx', 'Deleted.jsx'],
      text: ['lbs', '/^Week \\d+$/'],
    });
  });

  it('a text that only an exempt file uses is stale too', () => {
    const scan = scanHardcoded({
      root,
      allow: { files: ['StudentProgramAuthor.jsx'], text: ['Draft a program'] },
    });
    expect(scan.unused).toEqual({ files: [], text: ['Draft a program'] });
  });

  it('stops on a file it cannot parse instead of passing over it', () => {
    write('zz/Broken.jsx', 'export default () => <p>Fine</p>;\nconst b = ;\n');
    try {
      expect(() => scanHardcoded({ root })).toThrow(/cannot read zz\/Broken\.jsx:2 — Parsing error/);
    } finally {
      rmSync(join(root, 'zz'), { recursive: true, force: true });
    }
  });

  it('refuses to run without a root, or on a folder that does not exist', () => {
    expect(() => scanHardcoded({})).toThrow(/`root` \(an absolute folder\) is required/);
    expect(() => scanHardcoded()).toThrow(/`root`/);
    expect(() => scanHardcoded({ root: join(root, 'nowhere') })).toThrow(/ENOENT/);
  });
});

describe('hardcodedScan: the real tree', () => {
  // No claim about what it finds — the wave-4 sweeps own that, folder by
  // folder. This only proves the parser reads every file of the app as it is
  // written today, so those tests start from a list and not from a crash.
  it('parses every source file under src/', () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const scan = scanHardcoded({ root: src });
    expect(scan.files).toBeGreaterThan(100);
    expect(scan.findings.every((f) => typeof f.text === 'string' && f.line > 0)).toBe(true);
  });
});
