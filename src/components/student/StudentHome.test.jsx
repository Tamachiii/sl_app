import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => ({ data: new Set(['sess-2']) }),
}));

// Mock supabase to return test data
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({ data: { id: 's-1' }, error: null }),
          order: () =>
            Promise.resolve({
              data: [
                {
                  id: 'prog-1',
                  name: 'P1',
                  weeks: [
                    {
                      id: 'w-1',
                      week_number: 1,
                      label: null,
                      sessions: [
                        { id: 'sess-1', title: 'Push Day', sort_order: 0 },
                        { id: 'sess-2', title: 'Pull Day', sort_order: 1 },
                      ],
                    },
                  ],
                },
              ],
              error: null,
            }),
        }),
      }),
    }),
  },
}));

import StudentHome from './StudentHome';

function renderStudentHome() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StudentHome />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('StudentHome', () => {
  it('renders header title', () => {
    renderStudentHome();
    expect(screen.getByText('My Program')).toBeInTheDocument();
  });

  it('renders session buttons and clicks one', async () => {
    const user = userEvent.setup();
    renderStudentHome();

    const pushDay = await screen.findByText('Push Day');
    expect(pushDay).toBeInTheDocument();

    await user.click(pushDay);
    expect(mockNavigate).toHaveBeenCalledWith('/student/session/sess-1');
  });

  it('renders week number', async () => {
    renderStudentHome();
    expect(await screen.findByText(/Week 1/)).toBeInTheDocument();
  });

  it('shows a Done badge next to confirmed sessions', async () => {
    renderStudentHome();
    // sess-2 ("Pull Day") is the confirmed one per the mock
    await screen.findByText('Pull Day');
    expect(screen.getByLabelText('Confirmed')).toBeInTheDocument();
  });
});
