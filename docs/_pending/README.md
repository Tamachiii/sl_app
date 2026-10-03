# docs/_pending — documentation waiting to be folded

A package that changes a rule, a mechanism, a command or the file map does **not** edit `CLAUDE.md`, `README.md`, `docs/INVARIANTS.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, `docs/ENVIRONMENT.md` or `docs/RUNBOOK.md`. It writes one snippet file here. The integrator folds every snippet into its target document at the end of the wave, in one docs commit, and deletes the file.

The reason is ownership: those documents are single files that many packages would edit at the same time. The cost is that they lag by up to one wave inside the branch — so when a document and a snippet disagree, the snippet is the newer one.

Not covered by this folder: the pages under `docs/runbook/` (written directly by the lane that owns the subject) and `BACKUPS.md` (tooling lane).

## The file

One file per package: `docs/_pending/<package-id>.md`. A package with nothing to document writes no file.

````markdown
# <package-id> — docs to fold (wave N, items P12, L7)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — <heading of the section>

Add after the bullet that starts "<first words of the bullet before it>":

- **<The rule, as one bold sentence.>** <Where it is enforced — `<function, trigger or file>` — and what breaks without it.>

## CLAUDE.md — Feature → files map, row "<name of the row>"

Replace the row's file list with:

`<folder/Component>`, `<hooks/useSomething>`, …

## README.md — <heading of the section>

Replace "<the sentence as it reads today>" with:

<the sentence as it must read>

## docs/ARCHITECTURE.md — <heading of the section>

Delete the paragraph that starts "<first words>": <what it described> no longer exists.
````

### Format

1. **Title**: `# <package-id> — docs to fold (wave N, items …)`. The id is the one in the execution plan; an enabler writes `items: none`.
2. **One `##` block per change**, headed `## <target doc> — <section>`. The target is the path from the repository root (`CLAUDE.md`, `README.md`, `docs/INVARIANTS.md`, …). The section is the heading in that document the text belongs under, or `new section "<title>"` with the heading it goes after.
3. **First line of a block: the operation** — *Add*, *Replace* or *Delete* — and enough of the current text (its first words, a table row's name) for the integrator to find the place without reading the diff.
4. **Then the text itself, ready to paste**, written the way the target document writes: a bullet with a bold lead for `INVARIANTS.md`, a table row for the feature map, prose for `ARCHITECTURE.md`. "Document the new guard" is not a snippet; the sentence that documents it is.
5. **A `##` line outside a code fence is always a block heading.** When the text to fold has a heading of its own (a new section), quote the whole text in a fence of four back-ticks.

`src/test/docsSuite.test.js` holds the parts the integrator relies on to find things: the file name, the title line, and a `## <target doc> — <section>` heading whose target exists (`docs/RUNBOOK.md` and `docs/runbook/…` may not exist yet). It runs with `npm test`.

### Rules

- **Describe the code as it is at the end of the package**, in the present tense. No history ("we used to"), no plan ("will be added in wave 5") — a later package writes its own snippet.
- **Name files, functions, tables and columns in back-ticks**, spelled exactly. From wave 4, `npm run test:docs` checks that every back-ticked identifier and `src` path in the folded documents exists in the repository. This folder is not checked, because a snippet may name something another lane of the same wave is still creating.
- **Say what becomes false.** If the change makes an existing sentence wrong, add a *Delete* or *Replace* block for it. A stale rule is worse than a missing one: a later review will "fix" correct code towards it.
- **Which document**:
  | Target | What goes there |
  |---|---|
  | `docs/INVARIANTS.md` | A behaviour the code must keep, or a schema trap: something a future change could break without a test noticing |
  | `docs/ARCHITECTURE.md` | How a mechanism works: tables, RLS model, query keys, offline, push, the i18n and test plumbing |
  | `docs/DESIGN_SYSTEM.md` | UI primitives, tokens, layout and accessibility patterns |
  | `docs/ENVIRONMENT.md` | Environment variables, secrets, dashboard settings |
  | `CLAUDE.md` | Repo map, a row of the feature → files map, commands, "When you add a feature" |
  | `README.md` | Setup, deployment, overview, test counts |
  | `docs/RUNBOOK.md` | The index only: checkpoints and the first-push checklist |
- **Anything the user must do by hand** (apply a migration, change a dashboard setting, set a secret) goes to the runbook, not only into a snippet.
- **Strings are not documentation.** New UI text goes into an i18n fragment — see `src/lib/i18n/fragments/README.md`.

## Folding (integrator, end of every wave)

For each file: apply its blocks to the target documents, check the result against the code, delete the file. Everything goes into one docs commit per wave. This `README.md` stays; an empty folder otherwise means the documents are current.
