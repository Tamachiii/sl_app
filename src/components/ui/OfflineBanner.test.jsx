import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from '@tanstack/react-query';
import OfflineBanner from './OfflineBanner';

const onlineDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'onLine'
);

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  if (onlineDescriptor) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', onlineDescriptor);
  }
});

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function withClient(qc) {
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('<OfflineBanner />', () => {
  it('keeps the wrapper mounted but collapsed while online', () => {
    setOnline(true);
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    const wrapper = screen.getByTestId('offline-banner-wrapper');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper).toHaveStyle({ maxHeight: '0px' });
  });

  it('does not flash when an in-flight (non-paused) mutation is pending while online', () => {
    setOnline(true);
    const qc = makeClient();
    qc.setMutationDefaults(['inflight'], {
      networkMode: 'always',
      mutationFn: () => new Promise(() => {}),
    });
    render(<OfflineBanner />, { wrapper: withClient(qc) });

    act(() => {
      qc.getMutationCache()
        .build(qc, {
          mutationKey: ['inflight'],
          networkMode: 'always',
          mutationFn: () => new Promise(() => {}),
        })
        .execute({});
    });

    // A normal online tap fills the cache with a pending (but not paused)
    // mutation. The banner must stay collapsed — that was the flicker bug.
    const wrapper = screen.getByTestId('offline-banner-wrapper');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('expands and shows the offline notice when navigator.onLine is false', () => {
    setOnline(false);
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const wrapper = screen.getByTestId('offline-banner-wrapper');
    expect(wrapper).toHaveAttribute('aria-hidden', 'false');
    expect(wrapper).not.toHaveStyle({ maxHeight: '0px' });
    expect(screen.getByTestId('offline-banner')).toHaveTextContent(/Offline/i);
  });

  it('does not update its own state while a sibling with useMutation renders', () => {
    // Regression: the banner used to mirror the paused count into useState via
    // a raw mutationCache.subscribe. React Query notifies that listener
    // SYNCHRONOUSLY, and useMutation builds its observer during render (the
    // MutationObserver constructor calls setOptions, which notifies the cache).
    // Any page mounting a mutation hook under the already-committed banner
    // therefore tripped React's "Cannot update a component (OfflineBanner)
    // while rendering a different component (X)" warning. Dev-only today, but
    // it is the exact pattern concurrent rendering breaks.
    setOnline(true);
    const qc = makeClient();

    function Sibling() {
      useMutation({ mutationKey: ['sibling'], mutationFn: () => Promise.resolve() });
      return <div data-testid="sibling" />;
    }

    function Harness() {
      const [mounted, setMounted] = useState(false);
      return (
        <>
          <OfflineBanner />
          <button onClick={() => setMounted(true)}>mount</button>
          {mounted ? <Sibling /> : null}
        </>
      );
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByText } = render(<Harness />, { wrapper: withClient(qc) });
      // The banner is committed first; the sibling mounts afterwards, which is
      // what makes the cache notification land mid-render.
      act(() => {
        getByText('mount').click();
      });
      expect(screen.getByTestId('sibling')).toBeInTheDocument();

      const renderPhaseWarnings = spy.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((line) => /while rendering a different component/i.test(line));
      expect(renderPhaseWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reflects the count of paused mutations in the offline notice', async () => {
    setOnline(false);
    const qc = makeClient();

    render(<OfflineBanner />, { wrapper: withClient(qc) });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    // Build a mutation that React Query will park as paused (networkMode
    // 'online' + offline). The banner's mutation-cache subscription should
    // pick it up and render the count.
    act(() => {
      qc.getMutationCache()
        .build(qc, {
          mutationKey: ['paused-test'],
          networkMode: 'online',
          mutationFn: () => Promise.resolve(),
        })
        .execute({});
    });

    const banner = await screen.findByTestId('offline-banner');
    expect(banner).toHaveTextContent(/1 change/);
  });
});
