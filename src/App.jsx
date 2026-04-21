import { HashRouter, useRoutes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import { I18nProvider } from './hooks/useI18n';
import { queryClient } from './lib/queryClient';
import { routes } from './routes';
import ErrorBoundary from './components/ui/ErrorBoundary';

function AppRoutes() {
  return useRoutes(routes);
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <HashRouter>
              <ErrorBoundary>
                <AppRoutes />
              </ErrorBoundary>
            </HashRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
