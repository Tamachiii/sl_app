import { QueryClient } from '@tanstack/react-query';

// Shared test-client factory. There is deliberately no render-with-providers
// wrapper here: `useAuth`'s context is module-private, so any wrapper defined
// outside that module can only provide a context no component reads. Tests
// therefore stub the hook layer instead — `vi.mock('../hooks/useAuth', ...)` —
// and render the component directly, which is what all of them already do.
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}
