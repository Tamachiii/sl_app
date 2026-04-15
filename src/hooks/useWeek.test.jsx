import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWeek, useDeleteWeek } from './useWeek';
import { createTestQueryClient } from '../test/utils';
import { QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = createTestQueryClient();
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useWeek', () => {
  it('fetches week and its sessions', async () => {
    // Mock the chained Supabase queries
    const mockWeekQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'w-1', week_number: 1 } }),
    };

    const mockSessionsQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      single: vi.fn(), // Not used for sessions
    };
    mockSessionsQuery.order.mockResolvedValue({
      data: [{ id: 's-1', week_id: 'w-1', exercise_slots: [] }],
    });

    supabase.from.mockImplementation((table) => {
      if (table === 'weeks') return mockWeekQuery;
      if (table === 'sessions') return mockSessionsQuery;
      return {};
    });

    const { result } = renderHook(() => useWeek('w-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.id).toBe('w-1');
    expect(result.current.data.sessions).toHaveLength(1);
    expect(supabase.from).toHaveBeenCalledWith('weeks');
    expect(supabase.from).toHaveBeenCalledWith('sessions');
  });
});

describe('useDeleteWeek', () => {
  it('deletes week and invalidates queries', async () => {
    const mockDelete = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(mockDelete);

    const queryClient = createTestQueryClient();
    queryClient.invalidateQueries = vi.fn();
    
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDeleteWeek(), { wrapper });

    result.current.mutate('w-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('weeks');
    expect(mockDelete.eq).toHaveBeenCalledWith('id', 'w-1');
    
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['week', 'w-1'] });
  });
});
