import { defineConfig } from 'vitest/config';

// The DOCS suite (`npm run test:docs`): tests about the documentation itself,
// kept under docs/ next to what they check. It is EMPTY until
// docs/identifiers.test.js lands (every back-ticked identifier or src path
// named in the docs exists in the repository), and `passWithNoTests` keeps the
// command green until then, so the gate and CI can call it from day one.
//
// Deliberately separate from vite.config.js, like the database suite: no
// jsdom, no React, no PWA plugin. The default `npm test` excludes docs/**, so
// a package that renames a symbol is not stopped by a doc it does not own —
// the docs are folded and checked by the integrator, at the end of a wave.
export default defineConfig({
  test: {
    name: 'docs',
    environment: 'node',
    include: ['docs/**/*.test.js'],
    passWithNoTests: true,
  },
});
