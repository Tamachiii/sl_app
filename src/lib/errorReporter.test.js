import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { insert } = vi.hoisted(() => ({ insert: vi.fn(async () => ({ error: null })) }));
vi.mock('./supabase', () => ({ supabase: { from: vi.fn(() => ({ insert })) } }));

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** What the browser dispatches for a promise nobody caught. */
function reject(reason) {
  const event = new Event('unhandledrejection');
  event.reason = reason;
  window.dispatchEvent(event);
}

// Once: the handlers stay on `window` for the life of the file.
beforeAll(async () => {
  const reporter = await import('./errorReporter');
  reporter.setErrorReporterUser({ id: 'user-1', role: 'student' });
  reporter.installGlobalErrorReporting();
});

beforeEach(() => {
  insert.mockClear();
});

describe('what reaches the list of errors from a promise nobody caught', () => {
  it('a crash of the code does', async () => {
    reject(new TypeError("Cannot read properties of undefined (reading 'map')"));
    await flush();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({
      user_id: 'user-1',
      message: "Cannot read properties of undefined (reading 'map')",
    });
  });

  // A screen fetched ahead of its use (lib/preload) on a page older than the
  // files the server keeps: nobody awaits that import, so its failure arrives
  // here. It is a deploy, which lib/chunkRecovery deals with — not a crash.
  it('a file of the app that did not load does not', async () => {
    reject(new TypeError('Failed to fetch dynamically imported module: https://tamachiii.github.io/sl_app/assets/LoginPage-D3f1.js'));
    reject(new TypeError('Importing a module script failed.'));
    reject(new Error('Unable to preload CSS for /sl_app/assets/LoginPage-9aQ2.css'));
    await flush();

    expect(insert).not.toHaveBeenCalled();
  });

  it('a request to the API that failed still does: it is not a file of the app', async () => {
    reject(new TypeError('Failed to fetch'));
    await flush();

    expect(insert).toHaveBeenCalledTimes(1);
  });
});
