import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useStudentGoals,
  useStudentProfileId,
  useMyGoals,
  useCreateGoal,
  useUpdateGoal,
  useDeleteGoal,
  useAddGoalProgress,
  useToggleGoalAchieved,
  formatGoalTarget,
} from './useGoals';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

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

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'coach-1' } });
});

describe('useStudentGoals', () => {
  it('queries goals filtered by profile id (auth uid)', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useStudentGoals('profile-9'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('student_id', 'profile-9');
  });
});

describe('useStudentProfileId', () => {
  it('resolves students.id → profiles.id', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { profile_id: 'profile-7' },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProfileId('students-row-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe('profile-7');
  });
});

describe('useMyGoals', () => {
  it('queries goals filtered by current user.id', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useMyGoals(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('student_id', 'coach-1');
  });
});

describe('useCreateGoal', () => {
  it('injects coach_id from auth', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'g-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useCreateGoal(), { wrapper: withClient(qc) });
    result.current.mutate({ student_id: 'profile-9', kind: 'sets_reps' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      student_id: 'profile-9',
      kind: 'sets_reps',
      coach_id: 'coach-1',
    });
  });
});

describe('useUpdateGoal / useDeleteGoal / useAddGoalProgress', () => {
  it('useUpdateGoal updates by id', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'g-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useUpdateGoal(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'g-1', target_weight_kg: 100 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ target_weight_kg: 100 });
  });

  it('useDeleteGoal deletes by id', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useDeleteGoal(), { wrapper: withClient(qc) });
    result.current.mutate('g-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('id', 'g-1');
  });

  it('useAddGoalProgress writes to goal_progress', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'gp-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useAddGoalProgress(), { wrapper: withClient(qc) });
    result.current.mutate({ goalId: 'g-1', weight_kg: 100, sets: 3, reps: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      goal_id: 'g-1',
      weight_kg: 100,
      sets: 3,
      reps: 5,
      notes: null,
    });
  });
});

describe('useToggleGoalAchieved', () => {
  it('writes achieved_at=ISO when achieved=true', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'g-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useToggleGoalAchieved(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ id: 'g-1', achieved: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const payload = chain.update.mock.calls[0][0];
    expect(payload.achieved).toBe(true);
    expect(typeof payload.achieved_at).toBe('string');
  });

  it('writes achieved_at=null when achieved=false', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'g-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useToggleGoalAchieved(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ id: 'g-1', achieved: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ achieved: false, achieved_at: null });
  });
});

describe('formatGoalTarget', () => {
  it('formats one_rm goals', () => {
    expect(formatGoalTarget({ kind: 'one_rm', target_weight_kg: 120 })).toBe('1RM @ 120kg');
  });
  it('formats sets×reps goals', () => {
    expect(
      formatGoalTarget({
        kind: 'sets_reps',
        target_sets: 5,
        target_reps: 5,
        target_weight_kg: 100,
      }),
    ).toBe('5 × 5 @ 100kg');
  });
  it('returns "" for falsy goal', () => {
    expect(formatGoalTarget(null)).toBe('');
  });
});
