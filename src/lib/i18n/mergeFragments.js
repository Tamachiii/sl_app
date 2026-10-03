// A package ships its new strings as a FRAGMENT instead of editing en.js /
// fr.js / de.js: `fragments/<package-id>.<lang>.js`, default-exporting
// `{ <namespace>: { … } }` with one new top-level namespace. The rules, and
// who folds the fragments into the dictionaries, are in fragments/README.md.
//
// `modules` is what a glob over one language returns —
//   import.meta.glob('./fragments/*.fr.js', { eager: true, import: 'default' })
// — that is, file path → the fragment's default export.
//
// THE BASE DICTIONARY ALWAYS WINS. A fragment adds a namespace; one that
// names an existing namespace is a mistake, and parity.test.js reports it.
// Until someone fixes it the screens that are already translated keep their
// text, instead of a whole `common` or `student` tree going missing at
// runtime. Between two fragments the first file in path order wins, for the
// same reason: the result must not depend on the order a bundler lists files.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function mergeFragments(base, modules) {
  const added = {};
  for (const path of Object.keys(modules).sort()) {
    const fragment = modules[path];
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) continue;
    for (const [namespace, value] of Object.entries(fragment)) {
      if (!own(added, namespace)) added[namespace] = value;
    }
  }
  return { ...added, ...base };
}
