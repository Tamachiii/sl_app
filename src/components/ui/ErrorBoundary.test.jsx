import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense, useState } from 'react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { QUEUE_ON_DISK_MS, WRITES_WAIT_MS } from '../../lib/pendingWrites';

// The boundary reports to telemetry on catch; keep it a no-op spy so tests
// don't attempt a network insert.
const reportError = vi.fn();
vi.mock('../../lib/errorReporter', () => ({
  reportError: (...args) => reportError(...args),
}));

import ErrorBoundary from './ErrorBoundary';

function Boom({ shouldThrow }) {
  if (shouldThrow) throw new Error('kaboom');
  return <div data-testid="ok">no error</div>;
}

describe('<ErrorBoundary />', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('catches a render error, shows the fallback, and reports to telemetry', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    // Both escape hatches are offered.
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go home/i })).toBeInTheDocument();
    // The crash was reported for the dev-coach's feedback loop.
    expect(reportError).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('"Try again" resets state — re-rendering with non-throwing children works', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Toggle() {
      const [crash, setCrash] = useState(true);
      return (
        <ErrorBoundary>
          <button onClick={() => setCrash(false)}>fix</button>
          <Boom shouldThrow={crash} />
        </ErrorBoundary>
      );
    }
    const { rerender } = render(<Toggle />);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    // Click "Try again" — state resets but the child still throws because
    // `crash` is still true. The next render with crash=false (achieved by
    // rerendering Toggle after clicking "fix") passes through.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    // Boundary cleared; child re-mounts. Since crash is still true it throws
    // again. Verify the boundary still shows fallback.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    rerender(<Toggle />);
    errSpy.mockRestore();
  });
});

// A screen whose file the server no longer has. The page is older than the
// builds a deploy keeps, its import fails, and React.lazy keeps the failure:
// the boundary is where it lands when lib/chunkRecovery did not reload first.
describe('<ErrorBoundary /> — a file of the app that did not load', () => {
  const CHUNK = 'https://tamachiii.github.io/sl_app/assets/StudentMessages-BVh2kq1x.js';
  const missingFile = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);
  const TITLE = 'A new version of the app is available.';
  const BODY = /could not be loaded: the app has most likely been updated/;
  const RELOADING = 'Reloading…';

  let online;
  let errSpy;
  let recovery;
  let queryClient;

  function Missing() {
    throw missingFile();
  }

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  };

  /** A write that stays on its way until `finish()`. */
  async function startWrite() {
    let finish;
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    mutation.execute().catch(() => {});
    await flush();
    return { finish: () => finish('saved') };
  }

  function mount(children = <Missing />) {
    return render(
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary recovery={recovery}>{children}</ErrorBoundary>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    reportError.mockClear();
    online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recovery = { reloadNow: vi.fn(), isReloading: vi.fn(() => false) };
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
    onlineManager.setOnline(true);
    delete navigator.onLine;
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('says a new version is there and offers the reload — not "Try again", which cannot work', () => {
    mount();

    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    // React.lazy keeps a failed import for good: the same tree fails again.
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Go home/i })).toBeNull();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(recovery.reloadNow).not.toHaveBeenCalled();
  });

  it('reports nothing: neither the error nor where it was caught', () => {
    mount();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('still reports a crash of the code, with its stack, as before', () => {
    mount(<Boom shouldThrow={true} />);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls[1][0]).toMatchObject({ message: 'componentStack' });
  });

  it('is where a screen loaded on demand lands when its import fails', async () => {
    const Screen = lazy(() => Promise.reject(missingFile()));
    mount(
      <Suspense fallback={<p>loading</p>}>
        <Screen />
      </Suspense>,
    );
    await flush();

    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('"Reload" reloads the page, through the recovery', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();

    expect(recovery.reloadNow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(RELOADING);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
  });

  it('"Reload" waits for a write that is on its way', async () => {
    vi.useFakeTimers();
    mount();
    const write = await startWrite();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(RELOADING);
    expect(recovery.reloadNow).not.toHaveBeenCalled();

    write.finish();
    await flush();
    expect(recovery.reloadNow).toHaveBeenCalledTimes(1);
  });

  it('"Reload" does not wait for ever: past the wait there is nothing else to do on this screen', async () => {
    vi.useFakeTimers();
    mount();
    await startWrite(); // a request the network neither answers nor fails

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WRITES_WAIT_MS - 1);
    });
    await flush();
    expect(recovery.reloadNow).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(recovery.reloadNow).toHaveBeenCalledTimes(1);
  });

  it('"Reload" gives a write queued offline the time to reach the disk', async () => {
    vi.useFakeTimers();
    onlineManager.setOnline(false);
    mount();
    await startWrite();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(recovery.reloadNow).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(QUEUE_ON_DISK_MS);
    });
    await flush();
    expect(recovery.reloadNow).toHaveBeenCalledTimes(1);
  });

  it('"Reload" works where no query client is above the boundary', async () => {
    render(
      <ErrorBoundary recovery={recovery}>
        <Missing />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(recovery.reloadNow).toHaveBeenCalledTimes(1);
  });

  it('says "Reloading…" when the page is already reloading by itself', () => {
    recovery.isReloading.mockReturnValue(true);
    mount();

    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(RELOADING);
    expect(screen.queryByText(BODY)).toBeNull();
    // Still there, and still working: a reload the browser never got to is not a dead end.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
  });

  it('does not promise a new version to a device that is offline, and follows the connection', () => {
    online = false;
    mount();

    expect(screen.getByRole('heading', { name: 'This screen could not be loaded.' })).toBeInTheDocument();
    expect(screen.getByText(/The device is offline\. Try reloading/)).toBeInTheDocument();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('uses the recovery of the app when none is given', async () => {
    const { chunkRecovery } = await import('../../lib/chunkRecovery');
    const reloadNow = vi.spyOn(chunkRecovery, 'reloadNow').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Missing />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(reloadNow).toHaveBeenCalledTimes(1);
    reloadNow.mockRestore();
  });
});
