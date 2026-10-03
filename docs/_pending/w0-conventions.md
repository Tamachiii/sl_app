# w0-conventions — docs to fold (wave 0, items: none)

Each block: target doc, section, then the text to fold in.

## docs/ARCHITECTURE.md — new section "i18n: dictionaries and fragments", before "Testing"

Add:

````markdown
## i18n: dictionaries and fragments

`src/lib/i18n/en.js`, `fr.js` and `de.js` are the base dictionaries. `src/lib/i18n/index.js` exports `messages` — each base dictionary plus that language's **fragments** — and `getMessage(lang, key, params)`, which looks a dotted key up in `lang`, then in English, then returns the key itself.

A fragment is how a package adds strings without editing the three dictionaries: `src/lib/i18n/fragments/<package-id>.<lang>.js`, default-exporting an object with one new top-level namespace. `index.js` loads them with one `import.meta.glob` per language (`fragmentModules`) and `mergeFragments` (`src/lib/i18n/mergeFragments.js`) merges them. The base dictionary always wins: a fragment can add a namespace, never replace one. One glob per language is deliberate, so a language loaded on demand takes its fragments with it.

The integrator folds the fragments into the dictionaries at the end of waves 4 and 9 (copy the namespace, delete the three files); call sites do not change. The rules are in `src/lib/i18n/fragments/README.md` and enforced by `src/lib/i18n/parity.test.js`: three languages with identical keys, a camelCase namespace that exists neither in the base dictionaries nor in another package, non-empty string values, and no file in the folder that no language loads. `src/lib/i18n/usage.test.js` checks every literal `t('a.b')` call in `src/components` and `src/hooks` against the merged English dictionary. Both tests also run on a fixture package (`src/lib/i18n/__fixtures__/fragments/`), so the rules stay tested while the real folder is empty.
````

## docs/ARCHITECTURE.md — Testing

Add after the first paragraph:

There are three suites, each with its own command and config. `npm test` (`vite.config.js`, jsdom) is the unit suite and excludes `supabase/tests/**` and `docs/**`. `npm run test:db` (`vitest.db.config.js`) is the database suite. `npm run test:docs` (`vitest.docs.config.js`, node) runs the tests under `docs/`; it has no test yet and passes empty. `src/test/docsSuite.test.js` keeps the three apart and checks the format of the snippets in `docs/_pending/`.

`src/test/hardcodedScan.js` is test support for the per-folder "no hard-coded text" tests: `scanHardcoded({ root, allow })` parses every source file of a folder with ESLint's parser and lists JSX text, strings rendered as a JSX child and the literal values of text attributes (`aria-label`, `title`, `placeholder`, `alt`, and props such as `label`, `message` or `confirmLabel`). `allow.files` exempts whole files, `allow.text` exact strings or patterns, and `unused` names the allow-list entries that no longer exempt anything. It does not see a string that reaches the screen through a variable, an object or a function call.

## CLAUDE.md — Repo map

Replace the `lib/` and `test/` lines and add the two entries at the bottom:

```
  lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js
                 i18n/ (en · fr · de dictionaries, index.js, mergeFragments.js,
                 fragments/<package-id>.<lang>.js — strings of packages not yet folded)
  test/          setup.js  utils.jsx (createTestQueryClient)
                 hardcodedScan.js (lists hard-coded JSX text of a folder)
docs/            INVARIANTS.md  ARCHITECTURE.md  DESIGN_SYSTEM.md  ENVIRONMENT.md
                 _pending/ (doc snippets waiting for the end-of-wave fold)
vitest.db.config.js  vitest.docs.config.js   the database and docs suites
```

## CLAUDE.md — Feature → files map, row "i18n (EN/FR/DE)"

Replace the row's file list with:

`hooks/useI18n`, `lib/i18n/` (`index.js` exports the merged `messages` and `getMessage`; `mergeFragments.js`; `fragments/<package-id>.<lang>.js` + `fragments/README.md`; `parity.test.js` and `usage.test.js` hold the rules), `ui/LanguageSelect`, `test/hardcodedScan.js` (hard-coded text scanner for the per-folder tests)

## CLAUDE.md — Commands

Add after the `npm test -- --run` line:

```bash
npm run test:db   # database suite: schema.sql on a real Postgres (supabase/tests)
npm run test:docs # docs suite (tests under docs/); empty and green until wave 4
```

## CLAUDE.md — When you add a feature

Add as steps 3b and 3c, and replace step 6 ("Update `README.md` / `CLAUDE.md` / `docs/*` …") with the second one while the 2026-09 review plan is running:

- New UI strings: do not edit `src/lib/i18n/en.js`, `fr.js` or `de.js`. Add `src/lib/i18n/fragments/<package-id>.en.js`, `.fr.js` and `.de.js` with one new camelCase namespace (rules in `src/lib/i18n/fragments/README.md`), then run `npx vitest run src/lib/i18n --maxWorkers=2`.
- Docs: do not edit `CLAUDE.md`, `README.md` or `docs/*.md` from a feature package. Write `docs/_pending/<package-id>.md` in the format of `docs/_pending/README.md`; the integrator folds it at the end of the wave. Runbook pages under `docs/runbook/` are written directly by the lane that owns them.

## README.md — Design System, Theming, and i18n, bullet "i18n"

Add at the end of the bullet:

A package adds strings as a fragment — `src/lib/i18n/fragments/<package-id>.<lang>.js`, one new namespace, in the three languages — which `src/lib/i18n/index.js` merges into the dictionary of its language; fragments are folded into `en.js` / `fr.js` / `de.js` at the end of waves 4 and 9 (`src/lib/i18n/fragments/README.md`).

## README.md — Testing Conventions

Replace the test counts: this package adds 2 files and 76 tests (86 files / 989 tests if it started from 84 / 913): `src/test/hardcodedScan.test.js` (30), `src/test/docsSuite.test.js` (17), `src/lib/i18n/parity.test.js` (2 → 27), `src/lib/i18n/usage.test.js` (2 → 6).

Add to the list of static guardrails: "i18n fragment rules, the split between the unit, database and docs suites, the format of `docs/_pending` snippets".

Add to the Run block:

```bash
npm run test:docs        # tests about the docs (under docs/); empty until wave 4
```
