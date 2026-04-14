import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createContext } from 'react';
import { ThemeProvider } from '../hooks/useTheme';

// Re-create AuthContext so tests don't depend on the real provider
const AuthContext = createContext(null);

const defaultAuth = {
  user: { id: 'user-1', email: 'coach@test.com' },
  profile: { id: 'user-1', role: 'coach', full_name: 'Test Coach' },
  role: 'coach',
  isLoading: false,
  signIn: vi.fn(),
  signOut: vi.fn(),
};

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui, { auth = defaultAuth, route = '/', queryClient, ...options } = {}) {
  const qc = queryClient || createTestQueryClient();

  function Wrapper({ children }) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <AuthContext.Provider value={auth}>
            <MemoryRouter initialEntries={[route]}>
              {children}
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient: qc };
}

export { AuthContext, defaultAuth };
