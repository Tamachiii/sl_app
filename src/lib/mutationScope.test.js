import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mutationScope, laterWriteQueued } from './mutationScope';

describe('mutationScope', () => {
  it('names a scope after what it is for and whose it is', () => {
    expect(mutationScope('block-order', 'p-1')).toEqual({ id: 'block-order-p-1' });
  });

  it('is no scope at all while the id is not known', () => {
    expect(mutationScope('block-order', undefined)).toBeUndefined();
    expect(mutationScope('block-order', null)).toBeUndefined();
  });
});

describe('laterWriteQueued', () => {
  // The mutations are made the way `useMutation` makes them: built in the
  // client's cache from their options, then executed.
  function run(qc, options) {
    return qc.getMutationCache().build(qc, options).execute();
  }

  it('is true for the first of two writes of a scope and false for the last', async () => {
    const qc = new QueryClient();
    const scope = mutationScope('block-order', 'p-1');
    const answers = [];
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const asking = (mutationFn) => ({
      scope,
      mutationFn,
      // `onSettled` is where a hook asks: the mutation is still pending there.
      onSettled: () => {
        answers.push(laterWriteQueued(qc, scope));
      },
    });

    const first = run(qc, asking(() => held));
    const second = run(qc, asking(() => Promise.resolve()));
    // A write of another block is nobody's sibling.
    const elsewhere = run(qc, {
      scope: mutationScope('block-order', 'p-2'),
      mutationFn: () => held,
    });

    release();
    await Promise.all([first, second, elsewhere]);
    expect(answers).toEqual([true, false]);
  });

  it('is false for a write that fails with nothing behind it', async () => {
    const qc = new QueryClient();
    const scope = mutationScope('block-order', 'p-1');
    let answer = null;
    await run(qc, {
      scope,
      mutationFn: () => Promise.reject(new Error('refused')),
      onSettled: () => {
        answer = laterWriteQueued(qc, scope);
      },
    }).catch(() => {});
    expect(answer).toBe(false);
  });

  it('is false without a scope: such a write never waits for another', () => {
    const qc = new QueryClient();
    expect(laterWriteQueued(qc, undefined)).toBe(false);
    expect(laterWriteQueued(qc, mutationScope('block-order', null))).toBe(false);
  });
});
