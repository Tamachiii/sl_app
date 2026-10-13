import { expect, it } from 'vitest';

// Fails on purpose. See vitest.config.js in this folder.
it('a test of the database suite that fails', () => {
  expect('what the database answered').toBe('what the test expected');
});
