import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

let mockData = { data: [], isLoading: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ studentId: 's-1' }) };
});

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useStudentConfirmations: () => mockData,
}));

import ConfirmedSessions from './ConfirmedSessions';

function renderPage() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <ConfirmedSessions />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('ConfirmedSessions', () => {
  it('shows loading spinner', () => {
    mockData = { data: undefined, isLoading: true };
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows empty state when no confirmations', () => {
    mockData = { data: [], isLoading: false };
    renderPage();
    expect(screen.getByText(/no confirmed sessions yet/i)).toBeInTheDocument();
  });

  it('renders a row per confirmed session with session title, week, and notes', () => {
    mockData = {
      data: [
        {
          id: 'c-1',
          session_id: 'sess-1',
          session_title: 'Push Day',
          day_number: 1,
          week_number: 2,
          week_label: 'Volume block',
          confirmed_at: '2026-04-14T10:00:00Z',
          notes: 'Felt strong today',
        },
      ],
      isLoading: false,
    };
    renderPage();

    expect(screen.getByText('Push Day')).toBeInTheDocument();
    expect(screen.getByText(/Week 2 — Volume block · Day 1/)).toBeInTheDocument();
    expect(screen.getByText('Felt strong today')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Push Day/ });
    expect(link).toHaveAttribute('href', '/coach/student/s-1/session/sess-1/review');
  });
});
