import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom';

// What the athlete page shows when its reads have not produced a block
// (review item P49): it used to be a spinner for ever. The sheet and the
// switcher are stand-ins — this file is about the page around them.

const refetchPrograms = vi.fn();
const refetchProgram = vi.fn();
const ensureProgram = { mutate: vi.fn(), isPending: false };
let programsRead;
let programRead;

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => programsRead,
  useProgram: () => programRead,
  useEnsureProgram: () => ensureProgram,
}));
vi.mock('./ProgramSheet', () => ({
  default: ({ program }) => <div data-testid="sheet">sheet:{program.id}</div>,
}));
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useReviewCounts: () => ({ data: {} }),
}));
vi.mock('./ProgramSwitcher', () => ({
  default: ({ selectedId }) => <div data-testid="switcher">switcher:{selectedId}</div>,
}));

import StudentOverview from './StudentOverview';

const BLOCKS = [
  { id: 'p-1', name: 'Block one', is_active: true, status: 'approved' },
  { id: 'p-2', name: 'Block two', is_active: false, status: 'approved' },
];

// A read as useQuery reports it.
function read(overrides) {
  return {
    data: undefined,
    isSuccess: false,
    isError: false,
    isPaused: false,
    isFetching: false,
    fetchStatus: 'idle',
    ...overrides,
  };
}

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function renderSection(entry = '/coach/students/s-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/coach/students/:studentId" element={<Outlet context={{ student: { id: 's-1' } }} />}>
          <Route index element={<StudentOverview />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  refetchPrograms.mockReset();
  refetchProgram.mockReset();
  ensureProgram.mutate.mockReset();
  ensureProgram.isPending = false;
  programsRead = read({ data: BLOCKS, isSuccess: true, refetch: refetchPrograms });
  programRead = read({ data: { id: 'p-1', status: 'approved', weeks: [] }, isSuccess: true, refetch: refetchProgram });
});

describe('StudentOverview without a block to show', () => {
  it('shows the sheet when both reads answered', () => {
    renderSection();
    expect(screen.getByTestId('sheet')).toHaveTextContent('sheet:p-1');
  });

  it('says the list of blocks could not be read, and asks again on Retry', () => {
    programsRead = read({ isError: true, refetch: refetchPrograms });
    programRead = read({ refetch: refetchProgram });
    renderSection();

    expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
    expect(screen.queryByTestId('switcher')).toBeNull();
    // Not "no block yet": nothing is known about the blocks.
    expect(screen.queryByText(/no block yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create the first block' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchPrograms).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('says the list waits for the network when its read is paused', () => {
    programsRead = read({ isPaused: true, fetchStatus: 'paused', refetch: refetchPrograms });
    programRead = read({ refetch: refetchProgram });
    renderSection();

    expect(screen.getByText('This isn’t on this device yet')).toBeInTheDocument();
  });

  it('says the block could not be read, keeps the switcher, and asks again on Retry', () => {
    programRead = read({ isError: true, refetch: refetchProgram });
    renderSection();

    expect(screen.getByTestId('switcher')).toBeInTheDocument();
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchProgram).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('keeps the spinner while the block is on its way', () => {
    programRead = read({ fetchStatus: 'fetching', isFetching: true, refetch: refetchProgram });
    renderSection();

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('This couldn’t be loaded')).toBeNull();
  });

  it('says a block that is gone is not found, and shows the current one on the tap', () => {
    programRead = read({ data: null, isSuccess: true, refetch: refetchProgram });
    renderSection('/coach/students/s-1?program=p-2');

    expect(screen.getByText('Program not found')).toBeInTheDocument();
    expect(screen.queryByTestId('sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the current block' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/coach\/students\/s-1$/);
    expect(refetchPrograms).toHaveBeenCalledWith({ cancelRefetch: false });
  });
});

// Merely opening an athlete must not write a block: the coach creates the
// first one, by a tap.
describe('StudentOverview for an athlete without a block', () => {
  beforeEach(() => {
    programsRead = read({ data: [], isSuccess: true, refetch: refetchPrograms });
    programRead = read({ refetch: refetchProgram });
  });

  it('says so, and creates the first block on the tap', () => {
    renderSection();

    expect(screen.getByText('No block yet for this athlete.')).toBeInTheDocument();
    expect(screen.queryByTestId('switcher')).toBeNull();
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(ensureProgram.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create the first block' }));
    expect(ensureProgram.mutate).toHaveBeenCalledWith({ studentId: 's-1' });
  });

  it('takes no second tap while the block is being created', () => {
    ensureProgram.isPending = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Create the first block' })).toBeDisabled();
  });
});

// Review item P53: an athlete's draft is read-only for the coach until it is
// approved; the sheet says so above the block.
describe('StudentOverview on an athlete\u2019s draft', () => {
  it('says the block is a draft and where it is approved', () => {
    programRead = read({ data: { id: 'p-1', status: 'draft', weeks: [] }, isSuccess: true, refetch: refetchProgram });
    renderSection();

    expect(screen.getByRole('note')).toHaveTextContent(/draft written by your athlete/i);
    expect(screen.getByRole('note')).toHaveTextContent(/⋯ menu/);
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
  });

  it('says nothing on an approved block', () => {
    renderSection();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
