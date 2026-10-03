# i18n fragments

A package that needs new strings does **not** edit `../en.js`, `../fr.js` or `../de.js`. It adds three files here, one per language, and the integrator folds them into the dictionaries at the end of waves 4 and 9. Until then the app reads them from this folder: `../index.js` merges them into the dictionary of their language.

The reason is ownership. The three dictionaries are one file each, and every package that adds a screen needs keys. With fragments, two packages running in parallel never touch the same file.

## The three files

```
src/lib/i18n/fragments/<package-id>.en.js
src/lib/i18n/fragments/<package-id>.fr.js
src/lib/i18n/fragments/<package-id>.de.js
```

`<package-id>` is the package's id in the execution plan, in kebab-case (`coach-review-flow`, `sweep-student-i18n`).

Each file default-exports an object with **one** top-level key, the package's namespace:

```js
// src/lib/i18n/fragments/session-checkin.en.js
export default {
  sessionCheckin: {
    title: 'How did it go?',
    rpe: 'Session RPE',
    pain: {
      question: 'Any pain?',
      note: 'Where, and when did it start?',
    },
    saved: 'Saved for {name}',
  },
};
```

```jsx
const { t } = useI18n();
t('sessionCheckin.pain.question');
t('sessionCheckin.saved', { name });
```

## Rules

`../parity.test.js` checks every one of them and names the file at fault.

1. **Three languages, identical keys.** `en`, `fr` and `de` all exist for a package, and the French and German files have exactly the keys of the English one. A string you cannot translate yet is still written in all three files.
2. **One new top-level namespace, never a base key.** The namespace must not exist in `en.js`, `fr.js` or `de.js` (`common`, `student`, `coach`, … are taken), and no other package may use it. You cannot add to `student.*` from a fragment: put the keys under your own namespace.
3. **The namespace is camelCase** (`sessionCheckin`), and key names use letters, digits and `_` only. Anything else is invisible to `../usage.test.js`, which reads literal `t('a.b.c')` calls.
4. **Values are non-empty strings.** Parameters are written `{name}` and filled by `t(key, { name })`.
5. **Nothing else lives in this folder.** A file that no language loads (`foo.js`, `foo.es.js`, a sub-folder) fails the test, because its strings would silently never load.

What happens when a rule is broken at runtime, before anyone runs the tests:

- A fragment that names a base namespace is ignored for that namespace: **the base dictionary always wins**.
- Two fragments with the same namespace: the first file in path order wins.
- A key missing in French or German shows the English text.

## Tests to run

```bash
npx vitest run src/lib/i18n --maxWorkers=2
```

- `parity.test.js` — the merged dictionaries have the same keys in the three languages, and this folder obeys the rules above.
- `usage.test.js` — every literal `t('…')` key in `src/components` and `src/hooks` exists in the merged English dictionary, so a typo in a fragment key fails.

Both also run on a fixture package in `../__fixtures__/fragments/`, so the rules stay tested while this folder is empty.

## How it is wired

`../index.js` holds one glob per language:

```js
import.meta.glob('./fragments/*.fr.js', { eager: true, import: 'default' })
```

and `../mergeFragments.js` adds the namespaces of those files to the base dictionary of that language (the base wins on a clash). One glob per language is deliberate: when French and German become modules loaded on demand, each takes its own glob with it and nothing else changes.

`import.meta.glob` is expanded by Vite, so `../index.js` runs under Vite and Vitest only. A plain Node script that needs strings imports `../en.js` directly.

## Folding (integrator, waves 4 and 9)

For each package: copy the namespace object of each language into `en.js`, `fr.js` and `de.js` as a new top-level key, delete the three fragment files, and run the two tests. Call sites do not change, because the key paths are the same. Copying without deleting fails rule 2; the folder keeps this README when it is empty.
