import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '../../test/utils';
import AppShell from './AppShell';

vi.mock('./BottomNav', () => ({ default: () => <nav data-testid="bottom-nav" /> }));
vi.mock('./SideNav', () => ({ default: () => <nav data-testid="side-nav" /> }));
vi.mock('../ui/OfflineBanner', () => ({ default: () => null }));
vi.mock('../ui/ToastHost', () => ({ default: () => <div data-testid="toast-host" /> }));
vi.mock('../ui/UpdatePrompt', () => ({ default: () => <div data-testid="update-prompt" /> }));
vi.mock('../../hooks/useMessages', () => ({ useMessagesRealtime: vi.fn() }));
vi.mock('../../hooks/useNotifications', () => ({ useNotificationsRealtime: vi.fn() }));
vi.mock('../../lib/offlineMutations', () => ({ resumeMutationsAndReconcileDrafts: vi.fn() }));

beforeAll(() => {
  // jsdom has no element scrolling; the shell resets it on every route.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

describe('<AppShell />', () => {
  it('mounts the update prompt on every signed-in page, under the toasts', () => {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/student']}>
          <AppShell />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const prompt = screen.getByTestId('update-prompt');
    const toasts = screen.getByTestId('toast-host');
    // Later in the document = drawn on top at the same z-index: an error toast
    // covers the offer for its six seconds, never the other way round.
    expect(prompt.compareDocumentPosition(toasts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
