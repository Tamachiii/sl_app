import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Flat config, correctness-only: this rides the CI test gate to catch the
// classes of bug we keep hand-fixing (missing hook deps, unused symbols,
// undefined vars). It is deliberately NOT a formatter — no style rules — so
// it never churns the diff or fights the existing code.
export default [
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', '.claude/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The new JSX transform: no React import needed, no prop-types gate.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Curly quotes in JSX copy are intentional and everywhere; not a bug.
      'react/no-unescaped-entities': 'off',
      // Test wrappers and small inline components legitimately go unnamed.
      'react/display-name': 'off',
      // Allow intentional throwaways (rollback-context args, etc.).
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The load-bearing rule — conditional/early-return hooks are a hard
      // error (this is what catches real Rules-of-Hooks violations).
      'react-hooks/rules-of-hooks': 'error',
      // Informative but non-blocking: many existing effects deliberately omit
      // deps (documented in-code). Surfaced as warnings so new mistakes show
      // up in review without failing the gate on legacy patterns.
      'react-hooks/exhaustive-deps': 'warn',
      // react-hooks v7 advisory rules — too noisy to enforce on the existing
      // codebase without behavior-risky refactors; keep as warnings.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    // Service worker runs in its own global scope.
    files: ['src/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  {
    // Test + setup files: vitest globals, node env.
    files: ['**/*.test.{js,jsx}', 'src/test/**', '**/*.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, vi: 'readonly' } },
  },
];
