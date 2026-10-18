import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// The dialog runs on the REAL useExerciseUsage and a real query client, so
// that what it reads off the query — `dataUpdatedAt`, `errorUpdatedAt`,
// `isPaused` — is React Query's behaviour and not an assumption about it.
// Only the network is stubbed: `server(table)` is what a count read of that
// table answers.
let server;
const reads = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: (columns, options) => ({
        eq: async (column, value) => {
          reads(table, column, value, options);
          return { data: null, error: null, ...(await server(table)) };
        },
      }),
    }),
  },
}));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'coach-1' }, role: 'coach' }) }));

import ExerciseDeleteDialog from './ExerciseDeleteDialog';

const PULL_UP = { id: 'ex-1', name: 'Pull Up' };

// What the three count reads answer.
const counts = ({ slots = 0, goals = 0, swaps = 0 } = {}) => (table) =>
  ({ exercise_slots: { count: slots }, goals: { count: goals }, slot_deviations: { count: swaps } })[table];

// The app's defaults that matter here (lib/queryClient.js): an answer is
// served from the cache for two minutes, a failed read is retried once, and a
// read attempted offline waits for the network instead of failing.
function appLikeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 2,
        retry: 1,
        retryDelay: 1,
        networkMode: 'offlineFirst',
        gcTime: 1000 * 60 * 5,
      },
    },
  });
}

// `onArchive` is passed only when a test gives one: the page that cannot
// archive is the dialog as it was.
function renderDialog({ exercise = PULL_UP, qc = appLikeClient(), onArchive } = {}) {
  const onClose = vi.fn();
  const onDelete = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ExerciseDeleteDialog exercise={exercise} onClose={onClose} onDelete={onDelete} onArchive={onArchive} />
    </QueryClientProvider>,
  );
  return { onClose, onDelete, qc };
}

const deleteButton = () => screen.queryByRole('button', { name: 'Delete the exercise' });
const keepButton = () => screen.queryByRole('button', { name: 'Keep the exercise' });
// The way out written at the foot of the sheet once the exercise is known to
// be in use — « Keep the exercise », as in every other state, so the sheet
// never holds two buttons named « Close ».
const footClose = () => screen.queryByText('Keep the exercise', { selector: 'button' });
const status = () => screen.getByRole('status');
// The number shown next to a label of the usage list.
const usageCount = (label) => within(screen.getByText(label).closest('div')).getByRole('definition').textContent;

beforeEach(() => {
  server = counts();
  reads.mockReset();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('<ExerciseDeleteDialog />', () => {
  it('asks the question with the exercise’s name, in a Parc sheet', async () => {
    renderDialog();
    const sheet = screen.getByRole('dialog', { name: 'Delete Pull Up?' });
    expect(sheet).toHaveClass('pk-sheet-dialog');
    expect(within(sheet).getByRole('heading', { name: 'Delete Pull Up?' })).toBeInTheDocument();
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    expect(deleteButton()).toHaveClass('pk-btn', 'pk-btn-danger');
  });

  it('counts the slots, the goals and the swaps of THAT exercise, on the server', async () => {
    renderDialog();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
    const head = { count: 'exact', head: true };
    expect(reads).toHaveBeenCalledWith('exercise_slots', 'exercise_id', 'ex-1', head);
    expect(reads).toHaveBeenCalledWith('goals', 'exercise_id', 'ex-1', head);
    expect(reads).toHaveBeenCalledWith('slot_deviations', 'substitute_exercise_id', 'ex-1', head);
  });

  it('keeps Delete disabled until the usage has been read', async () => {
    let answer;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    server = async (table) => {
      await pending;
      return counts()(table);
    };
    const { onDelete } = renderDialog();

    expect(status()).toHaveTextContent('Checking where it is used…');
    // There, so that the button under the finger does not change when the
    // answer arrives — and not pressable.
    expect(deleteButton()).toBeDisabled();
    fireEvent.click(deleteButton());
    expect(onDelete).not.toHaveBeenCalled();

    answer();
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    expect(status()).toHaveTextContent('No session, goal or swap uses it.');
  });

  it('deletes an exercise nothing uses, and closes', async () => {
    const { onDelete, onClose } = renderDialog();
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    fireEvent.click(deleteButton());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('ex-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Keep the exercise" closes without deleting', async () => {
    const { onDelete, onClose } = renderDialog();
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    fireEvent.click(keepButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  describe('an exercise in use', () => {
    it('shows how many slots and goals use it, and offers no Delete', async () => {
      server = counts({ slots: 12, goals: 2 });
      const { onDelete, onClose } = renderDialog();

      await waitFor(() => expect(status()).toHaveTextContent('It is in use, so it cannot be deleted.'));
      expect(usageCount('Prescribed in sessions')).toBe('12');
      expect(usageCount('Goals set on it')).toBe('2');
      expect(screen.getByText(/Remove it from those sessions and goals first/)).toBeInTheDocument();
      expect(deleteButton()).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);

      fireEvent.click(footClose());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDelete).not.toHaveBeenCalled();
    });

    // Finding L7: where the goals foreign key still cascades, this delete
    // would take the athletes' goals and their logged progress with it.
    it('a goal alone is enough to withhold the Delete', async () => {
      server = counts({ goals: 1 });
      renderDialog();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(usageCount('Prescribed in sessions')).toBe('0');
      expect(usageCount('Goals set on it')).toBe('1');
      expect(deleteButton()).not.toBeInTheDocument();
    });

    it('so is one swap, which gets its own line only when there is one', async () => {
      server = counts({ swaps: 1 });
      renderDialog();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(usageCount('Swapped in by an athlete')).toBe('1');
      expect(deleteButton()).not.toBeInTheDocument();
    });

    it('has no swap line without a swap', async () => {
      server = counts({ slots: 3 });
      renderDialog();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(screen.queryByText('Swapped in by an athlete')).not.toBeInTheDocument();
    });
  });

  // Review decision P18: "in use, cannot be deleted" ended on an OK (now
  // "Close"). The exercise can leave the pickers by being archived, and the
  // dialog offers that where it says it cannot delete.
  describe('archiving instead', () => {
    const archiveButton = () => screen.queryByRole('button', { name: 'Archive instead' });

    it('offers it for an exercise in use, archives it, and closes', async () => {
      server = counts({ slots: 2, goals: 1 });
      const onArchive = vi.fn();
      const { onDelete, onClose } = renderDialog({ onArchive });

      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(screen.getByText(/Archiving takes it out of your pickers/)).toBeInTheDocument();
      expect(deleteButton()).not.toBeInTheDocument();
      expect(archiveButton()).toHaveClass('pk-btn', 'pk-btn-primary', 'pk-btn-lg');

      fireEvent.click(archiveButton());
      expect(onArchive).toHaveBeenCalledTimes(1);
      expect(onArchive).toHaveBeenCalledWith('ex-1');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('takes the place the disabled Delete held, never a place Keep held', async () => {
      let answer;
      const pending = new Promise((resolve) => {
        answer = resolve;
      });
      server = async (table) => {
        await pending;
        return counts({ slots: 1 })(table);
      };
      renderDialog({ onArchive: vi.fn() });
      const row = deleteButton().parentElement;
      expect([...row.children].map((b) => b.textContent)).toEqual(['Delete the exercise', 'Keep the exercise']);

      answer();
      await waitFor(() => expect(archiveButton()).toBeInTheDocument());
      expect([...row.children].map((b) => b.textContent)).toEqual(['Archive instead', 'Keep the exercise']);
    });

    it('is not offered while the usage is read, nor for an exercise nothing uses', async () => {
      let answer;
      const pending = new Promise((resolve) => {
        answer = resolve;
      });
      server = async (table) => {
        await pending;
        return counts()(table);
      };
      renderDialog({ onArchive: vi.fn() });
      expect(archiveButton()).not.toBeInTheDocument();
      answer();
      await waitFor(() => expect(deleteButton()).toBeEnabled());
      expect(archiveButton()).not.toBeInTheDocument();
    });

    it('is not offered when the usage could not be read', async () => {
      server = () => ({ count: null, error: { message: 'boom' } });
      renderDialog({ onArchive: vi.fn() });
      await waitFor(() => expect(status()).toHaveTextContent('could not be checked'));
      expect(archiveButton()).not.toBeInTheDocument();
    });

    it('is not offered for an exercise that is archived already', async () => {
      server = counts({ slots: 2 });
      renderDialog({ exercise: { ...PULL_UP, archived_at: '2026-10-15T08:00:00.000Z' }, onArchive: vi.fn() });
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(archiveButton()).not.toBeInTheDocument();
      expect(screen.queryByText(/Archiving takes it out of your pickers/)).not.toBeInTheDocument();
      expect(footClose()).toBeInTheDocument();
    });

    it('is not offered by a page that cannot archive', async () => {
      server = counts({ slots: 2 });
      renderDialog();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(archiveButton()).not.toBeInTheDocument();
    });
  });

  describe('when the usage cannot be read', () => {
    it('says so, deletes nothing, and reads again on request', async () => {
      server = () => ({ count: null, error: { message: 'boom' } });
      const { onDelete } = renderDialog();

      await waitFor(() => expect(status()).toHaveTextContent('could not be checked, so it is not deleted'));
      expect(deleteButton()).not.toBeInTheDocument();
      // The first read and its one retry, three tables each.
      expect(reads).toHaveBeenCalledTimes(6);

      server = counts();
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(deleteButton()).toBeEnabled());
      expect(status()).toHaveTextContent('No session, goal or swap uses it.');
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('does not take a failed read for "nothing uses it" when one count is missing', async () => {
      server = (table) => (table === 'goals' ? { count: null } : { count: 0 });
      renderDialog();
      await waitFor(() => expect(status()).toHaveTextContent('could not be checked'));
      expect(deleteButton()).not.toBeInTheDocument();
    });

    it('offline: waits, says so, and reads when the network is back', async () => {
      onlineManager.setOnline(false);
      server = () => {
        throw new TypeError('Failed to fetch');
      };
      renderDialog();

      await waitFor(() => expect(status()).toHaveTextContent('could not be checked'));
      expect(deleteButton()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();

      server = counts({ slots: 4 });
      onlineManager.setOnline(true);
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(usageCount('Prescribed in sessions')).toBe('4');
    });

    it('keeps the answer it has when a later refetch fails', async () => {
      const { qc } = renderDialog();
      await waitFor(() => expect(deleteButton()).toBeEnabled());

      server = () => ({ count: null, error: { message: 'boom' } });
      await qc.refetchQueries({ queryKey: ['exercise-usage', 'ex-1'] });
      expect(qc.getQueryState(['exercise-usage', 'ex-1']).status).toBe('error');
      expect(status()).toHaveTextContent('No session, goal or swap uses it.');
      expect(deleteButton()).toBeEnabled();
    });
  });

  describe('opened again', () => {
    // The page's use of it: the dialog stays mounted and `exercise` opens it.
    function Page() {
      const [exercise, setExercise] = useState(null);
      return (
        <>
          <button type="button" onClick={() => setExercise(PULL_UP)}>open</button>
          <ExerciseDeleteDialog exercise={exercise} onClose={() => setExercise(null)} onDelete={() => {}} />
        </>
      );
    }
    const renderPage = (qc) =>
      render(
        <QueryClientProvider client={qc}>
          <Page />
        </QueryClientProvider>,
      );

    it('reads nothing and shows nothing while closed', async () => {
      renderPage(appLikeClient());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
      expect(deleteButton()).not.toBeInTheDocument();
      expect(reads).not.toHaveBeenCalled();
    });

    it('reads again: a slot added since the last look withholds the Delete', async () => {
      renderPage(appLikeClient());
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      await waitFor(() => expect(deleteButton()).toBeEnabled());
      fireEvent.click(keepButton());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      server = counts({ slots: 1 });
      // Reopened at once, before anything could have cleared the first answer.
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      expect(deleteButton()).toBeDisabled();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(deleteButton()).not.toBeInTheDocument();
      expect(reads).toHaveBeenCalledTimes(6);
    });

    // The same rule with the cache made to hold an old answer on purpose:
    // the dialog decides on a read made since it opened, not on what is there.
    it('does not delete on an answer the cache held before it opened', async () => {
      const qc = appLikeClient();
      qc.setQueryData(['exercise-usage', 'ex-1'], { slots: 0, goals: 0, swaps: 0 }, { updatedAt: Date.now() - 30_000 });
      let answer;
      const pending = new Promise((resolve) => {
        answer = resolve;
      });
      server = async (table) => {
        await pending;
        return counts({ goals: 2 })(table);
      };
      renderPage(qc);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));

      expect(status()).toHaveTextContent('Checking where it is used…');
      expect(deleteButton()).toBeDisabled();

      answer();
      await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
      expect(usageCount('Goals set on it')).toBe('2');
    });

    // Timestamps alone cannot tell "read just before the open" from "read
    // since": a dialog closed and reopened within one millisecond finds an
    // answer exactly as old as itself. The clock is frozen to make that tie.
    it('nor on an answer cached in the very millisecond it opens', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date(2026, 9, 11, 12, 0, 0);
        vi.setSystemTime(now);
        const qc = appLikeClient();
        qc.setQueryData(['exercise-usage', 'ex-1'], { slots: 0, goals: 0, swaps: 0 }, { updatedAt: now.getTime() });
        let answer;
        const pending = new Promise((resolve) => {
          answer = resolve;
        });
        server = async (table) => {
          await pending;
          return counts({ slots: 1 })(table);
        };
        renderPage(qc);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));

        expect(status()).toHaveTextContent('Checking where it is used…');
        expect(deleteButton()).toBeDisabled();

        answer();
        await waitFor(() => expect(status()).toHaveTextContent('It is in use'));
        expect(deleteButton()).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    // A fetch has finished since the open, but it failed: the old answer is
    // still the only one there is, and it is still not from this open.
    it('nor on that answer when the read made at the open fails', async () => {
      const qc = appLikeClient();
      qc.setQueryData(['exercise-usage', 'ex-1'], { slots: 0, goals: 0, swaps: 0 }, { updatedAt: Date.now() - 30_000 });
      server = () => ({ count: null, error: { message: 'boom' } });
      renderPage(qc);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));

      await waitFor(() => expect(status()).toHaveTextContent('could not be checked'));
      expect(qc.getQueryData(['exercise-usage', 'ex-1'])).toEqual({ slots: 0, goals: 0, swaps: 0 });
      expect(deleteButton()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });
  });
});
