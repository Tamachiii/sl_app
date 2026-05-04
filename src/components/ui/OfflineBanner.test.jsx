import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  it('renders nothing when online with an empty queue', () => {
    setOnline(true);
    const qc = makeClient();
    const { container } = render(<OfflineBanner />, { wrapper: withClient(qc) });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the offline notice when navigator.onLine is false', () => {
    setOnline(false);
    const qc = makeClient();
    render(<OfflineBanner />, { wrapper: withClient(qc) });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const banner = screen.getByTestId('offline-banner');
    expect(banner).toHaveTextContent(/Offline/i);
  });

  it('reflects the count of pending mutations while offline', async () => {
    setOnline(false);
    const qc = makeClient();
    // Register a default fn that never resolves so the mutation stays pending.
    qc.setMutationDefaults(['paused-test'], {
      networkMode: 'offlineFirst',
      mutationFn: () => new Promise(() => {}),
    });

    render(<OfflineBanner />, { wrapper: withClient(qc) });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    act(() => {
      qc.getMutationCache().build(qc, {
        mutationKey: ['paused-test'],
        networkMode: 'offlineFirst',
        mutationFn: () => new Promise(() => {}),
      }).execute({});
    });

    const banner = await screen.findByTestId('offline-banner');
    expect(banner).toHaveTextContent(/1 change/);
  });
});
