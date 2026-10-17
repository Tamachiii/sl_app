import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  useMutation,
} from '@tanstack/react-query';
// The banner asks lib/persistence.js what a queued write is, which knows the
// keys of lib/offlineMutations.js — a module that opens the supabase client.
vi.mock('../../lib/supabase', () => ({ supabase: {} }));

import OfflineBanner from './OfflineBanner';
import { MUTATION_KEYS } from '../../lib/offlineMutations';

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
  delete navigator.onLine;
  onlineManager.setOnline(true);
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

  // A write of the queue, as a hook makes it: one of the registered keys.
  function queueWrite(qc, mutationKey, mutationFn = () => Promise.resolve()) {
    act(() => {
      qc.getMutationCache()
        .build(qc, { mutationKey, networkMode: 'online', retry: 3, retryDelay: 60_000, mutationFn })
        .execute({})
        .catch(() => {});
    });
  }

  function goOffline() {
    setOnline(false);
    act(() => {
      onlineManager.setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
  }

  it('counts the writes that wait for the network', async () => {
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    goOffline();

    queueWrite(qc, MUTATION_KEYS.toggleDone);
    expect(await screen.findByText('Offline. 1 change waits for the connection.')).toBeInTheDocument();

    queueWrite(qc, MUTATION_KEYS.confirmSession);
    expect(await screen.findByText('Offline. 2 changes wait for the connection.')).toBeInTheDocument();
  });

  it('a session that was only opened is not a change waiting to sync', async () => {
    // Opening a page can pause a write of its own — one without a key, or with
    // a key that is not of the queue. Nothing the athlete did, nothing that is
    // kept through a relaunch: it is not announced as waiting.
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    goOffline();

    act(() => {
      qc.getMutationCache()
        .build(qc, { networkMode: 'online', mutationFn: () => Promise.resolve() })
        .execute({ sessionId: 's-1' });
      qc.getMutationCache()
        .build(qc, { mutationKey: ['messages', 'mark-read'], networkMode: 'online', mutationFn: () => Promise.resolve() })
        .execute('coach-1');
    });
    await act(async () => {});

    expect(qc.getMutationCache().getAll().map((m) => m.state.isPaused)).toEqual([true, true]);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent(
      'Offline. Your changes are sent when the connection returns.',
    );

    // And next to a real one, it still is not counted.
    queueWrite(qc, MUTATION_KEYS.setRpe);
    expect(await screen.findByText('Offline. 1 change waits for the connection.')).toBeInTheDocument();
  });

  it('counts a write that is between two attempts when the network goes: it is owed like the others', async () => {
    // Online, on a network that does not answer: the write is not paused, it
    // sleeps until its next attempt. Then the phone notices it is offline.
    setOnline(true);
    onlineManager.setOnline(true);
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    queueWrite(qc, MUTATION_KEYS.toggleDone, () => Promise.reject(new TypeError('Failed to fetch')));
    await act(async () => {});
    const [write] = qc.getMutationCache().getAll();
    expect(write.state).toMatchObject({ status: 'pending', isPaused: false, failureCount: 1 });

    goOffline();

    expect(await screen.findByText('Offline. 1 change waits for the connection.')).toBeInTheDocument();
  });
});
