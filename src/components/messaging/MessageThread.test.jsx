import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

let mockThread = { data: [], isLoading: false, isError: false };
const mockMarkRead = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };
let mockSessionRefs = new Map();

vi.mock('../../hooks/useMessages', async () => {
  const actual = await vi.importActual('../../hooks/useMessages');
  return {
    ...actual,
    useMessageThread: () => mockThread,
    useMarkThreadRead: () => mockMarkRead,
    useDeleteMessage: () => mockDelete,
    useSessionRefsForMessages: () => mockSessionRefs,
  };
});

let mockAuth = { user: { id: 'me' }, role: 'coach' };
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => mockAuth,
}));

let mockStudents = [];
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: mockStudents }),
}));

let mockOnline = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

vi.mock('./MessageComposer', () => ({
  default: ({ recipientProfileId, recipientName }) => (
    <div data-testid="composer" data-recipient={recipientProfileId} data-name={recipientName ?? ''} />
  ),
}));

import MessageThread from './MessageThread';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderThread(otherProfileId = 'other', otherFullName = 'Alex') {
  return render(
    <MemoryRouter initialEntries={['/messages']}>
      <MessageThread otherProfileId={otherProfileId} otherFullName={otherFullName} />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAuth = { user: { id: 'me' }, role: 'coach' };
  mockStudents = [];
  mockOnline = true;
  mockSessionRefs = new Map();
  mockDelete.mutate.mockReset();
});

describe('MessageThread read receipt', () => {
  beforeEach(() => {
    mockMarkRead.mutate.mockReset();
  });

  it('shows "Sent" under the latest outgoing message when unread', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'hi', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });

  it('shows "Read {time}" when the latest outgoing message has read_at', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'hi', read_at: '2026-05-05T10:01:00Z', created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    // The day it was read: 2026-05-05 is not today, so « May 5 ».
    expect(screen.getByText('Read May 5')).toBeInTheDocument();
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument();
  });

  it('renders the receipt only once — under the most recent outgoing message', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'first', read_at: '2026-05-05T10:00:00Z', created_at: '2026-05-05T09:00:00Z' },
        { id: 'm2', sender_id: 'other', recipient_id: 'me', body: 'reply', read_at: null, created_at: '2026-05-05T09:30:00Z' },
        { id: 'm3', sender_id: 'me', recipient_id: 'other', body: 'second', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    // Only "Sent" appears (under m3) — no "Read" caption attached to m1.
    expect(screen.getAllByText('Sent')).toHaveLength(1);
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });

  it('omits the receipt when the latest message is incoming', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'other', recipient_id: 'me', body: 'reply', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });
});

const msg = (id, sender, body = id) => ({
  id,
  sender_id: sender,
  recipient_id: sender === 'me' ? 'other' : 'me',
  body,
  read_at: null,
  created_at: '2026-05-05T10:00:00Z',
});

describe('MessageThread states', () => {
  it('the log is named after the counterpart, and the composer writes to them', () => {
    mockThread = { data: [], isLoading: false, isError: false };
    renderThread();
    expect(screen.getByRole('log', { name: 'Messages with Alex' })).toBeInTheDocument();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-recipient', 'other');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-name', 'Alex');
  });

  it('waits for the messages with a spinner', () => {
    mockThread = { data: undefined, isLoading: true, isError: false };
    renderThread();
    expect(within(screen.getByRole('log')).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('No message yet. Say hello.')).not.toBeInTheDocument();
  });

  it('an empty thread invites a first message', () => {
    mockThread = { data: [], isLoading: false, isError: false };
    renderThread();
    expect(within(screen.getByRole('log')).getByText('No message yet. Say hello.')).toBeInTheDocument();
  });

  it('a thread that could not be read says so, and not that it is empty', () => {
    mockThread = { data: undefined, isLoading: false, isError: true };
    renderThread();
    expect(within(screen.getByRole('log')).getByText('The messages couldn’t be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No message yet. Say hello.')).not.toBeInTheDocument();
    // The composer stays: a message can be written while the history is away.
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });
});

describe('MessageThread bubbles', () => {
  it('a long URL wraps inside its bubble instead of widening the thread', () => {
    const url = `https://example.com/${'a'.repeat(300)}`;
    mockThread = { data: [msg('m1', 'other', url)], isLoading: false, isError: false };
    renderThread();
    // overflow-wrap: anywhere — break-words leaves the URL as the bubble's
    // smallest width, which the 80% column then overflows.
    expect(screen.getByText(url)).toHaveClass('wrap-anywhere');
  });

  it('my messages are blue, theirs on surface, each a paragraph', () => {
    mockThread = { data: [msg('m1', 'other', 'from them'), msg('m2', 'me', 'from me')], isLoading: false, isError: false };
    renderThread();
    const theirs = screen.getByText('from them');
    const mine = screen.getByText('from me');
    expect(theirs.tagName).toBe('P');
    expect(mine.tagName).toBe('P');
    expect(theirs).toHaveClass('bg-surface', 'text-ink');
    expect(theirs).not.toHaveClass('bg-blue');
    expect(mine).toHaveClass('bg-blue', 'text-on-blue');
  });

  it('the time of a run of one sender is under its last bubble, not inside it', () => {
    mockThread = {
      data: [msg('m1', 'other', 'one'), msg('m2', 'other', 'two'), msg('m3', 'me', 'three')],
      isLoading: false,
      isError: false,
    };
    renderThread();
    // One time per run: the other side's two messages, then mine.
    expect(screen.getAllByText('May 5')).toHaveLength(2);
    expect(screen.getByText('one')).toHaveTextContent(/^one$/);
    expect(screen.getByText('one').nextElementSibling).toBeNull();
    const two = screen.getByText('two');
    expect(two).toHaveTextContent(/^two$/);
    expect(two.nextElementSibling).toHaveTextContent('May 5');
    expect(screen.getByText('three').nextElementSibling).toHaveTextContent('May 5');
  });
});

describe('MessageThread marks what it shows as read', () => {
  beforeEach(() => {
    mockMarkRead.mutate.mockReset();
  });

  it('marks the thread read once for a new unread message from the other side', () => {
    mockThread = { data: [msg('m1', 'other')], isLoading: false, isError: false };
    const { rerender } = renderThread();
    expect(mockMarkRead.mutate).toHaveBeenCalledTimes(1);
    expect(mockMarkRead.mutate).toHaveBeenCalledWith('other');

    // A new array with the same messages: nothing new to mark.
    mockThread = { data: [msg('m1', 'other')], isLoading: false, isError: false };
    rerender(
      <MemoryRouter>
        <MessageThread otherProfileId="other" otherFullName="Alex" />
      </MemoryRouter>,
    );
    expect(mockMarkRead.mutate).toHaveBeenCalledTimes(1);
  });

  it('marks nothing when every incoming message is read, or the last ones are mine', () => {
    mockThread = {
      data: [{ ...msg('m1', 'other'), read_at: '2026-05-05T10:01:00Z' }, msg('m2', 'me')],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(mockMarkRead.mutate).not.toHaveBeenCalled();
  });
});

describe('MessageThread deletes a message of mine, after asking', () => {
  const dialog = () => screen.queryByRole('dialog', { name: 'Delete this message?' });

  it('a right-click on my message asks in a sheet, which deletes it for both', async () => {
    mockThread = { data: [msg('m1', 'me', 'see you at 6')], isLoading: false, isError: false };
    renderThread();
    expect(dialog()).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText('see you at 6'));
    const sheet = dialog();
    expect(sheet).toBeInTheDocument();
    expect(within(sheet).getByText('It goes for both of you: “see you at 6”')).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(mockDelete.mutate).toHaveBeenCalledTimes(1);
    expect(mockDelete.mutate).toHaveBeenCalledWith('m1');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('the sheet quotes the first 80 characters of a long message', () => {
    const long = 'x'.repeat(120);
    mockThread = { data: [msg('m1', 'me', long)], isLoading: false, isError: false };
    renderThread();
    fireEvent.contextMenu(screen.getByText(long));
    expect(within(dialog()).getByText(`It goes for both of you: “${'x'.repeat(80)}”`)).toBeInTheDocument();
  });

  it('Cancel leaves the message where it is', async () => {
    mockThread = { data: [msg('m1', 'me', 'keep me')], isLoading: false, isError: false };
    renderThread();
    fireEvent.contextMenu(screen.getByText('keep me'));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    expect(dialog()).not.toBeInTheDocument();
  });

  it('a press held on my message asks too; a press that moves or ends early does not', () => {
    vi.useFakeTimers();
    try {
      mockThread = { data: [msg('m1', 'me', 'held')], isLoading: false, isError: false };
      renderThread();
      const bubble = screen.getByText('held');

      fireEvent.pointerDown(bubble, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(300));
      fireEvent.pointerUp(bubble);
      act(() => vi.advanceTimersByTime(500));
      expect(dialog()).not.toBeInTheDocument();

      fireEvent.pointerDown(bubble, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(bubble, { clientX: 10, clientY: 30 });
      act(() => vi.advanceTimersByTime(500));
      expect(dialog()).not.toBeInTheDocument();

      fireEvent.pointerDown(bubble, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(450));
      expect(dialog()).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('their messages, and a feedback message about a session, cannot be deleted', () => {
    mockThread = {
      data: [msg('m1', 'other', 'theirs'), { ...msg('m2', 'me', 'my feedback'), session_id: 'sess-1' }],
      isLoading: false,
      isError: false,
    };
    renderThread();
    fireEvent.contextMenu(screen.getByText('theirs'));
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('my feedback'));
    expect(dialog()).not.toBeInTheDocument();
  });

  it('offline, nothing asks: a delete needs a connection', () => {
    vi.useFakeTimers();
    try {
      mockOnline = false;
      mockThread = { data: [msg('m1', 'me', 'offline one')], isLoading: false, isError: false };
      renderThread();
      const bubble = screen.getByText('offline one');
      fireEvent.contextMenu(bubble);
      fireEvent.pointerDown(bubble, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(500));
      expect(dialog()).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessageThread — the session a feedback message is about', () => {
  const feedback = { ...msg('m1', 'me', 'Great squats'), session_id: 'sess-1' };

  it('is a card above the message that opens the review, for the coach', async () => {
    mockStudents = [{ id: 's1', profile_id: 'other' }];
    mockSessionRefs = new Map([['sess-1', { id: 'sess-1', title: 'Lower A', scheduled_date: '2026-10-17' }]]);
    mockThread = { data: [feedback], isLoading: false, isError: false };
    renderThread();
    const card = screen.getByRole('button', { name: 'Open the session Lower A' });
    expect(card.nextElementSibling).toBe(screen.getByText('Great squats'));
    await userEvent.click(card);
    expect(screen.getByTestId('where')).toHaveTextContent('/coach/student/s1/session/sess-1/review');
  });

  it('opens the session itself, for the athlete', async () => {
    mockAuth = { user: { id: 'me' }, role: 'student' };
    mockThread = { data: [{ ...feedback, sender_id: 'other', recipient_id: 'me' }], isLoading: false, isError: false };
    renderThread();
    // The session is still on its way: the card is drawn all the same.
    await userEvent.click(screen.getByRole('button', { name: 'Open the session Session' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/student/session/sess-1');
  });
});

describe('MessageThread scroll', () => {
  // jsdom lays nothing out: the log gets a height, a content height and a
  // scrollTop that stays between 0 and its end, as a browser keeps it.
  let frames;
  let layout;

  function giveLayout(el) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => layout.clientHeight });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => layout.scrollTop,
      set: (v) => {
        layout.scrollTop = Math.max(0, Math.min(v, layout.scrollHeight - layout.clientHeight));
      },
    });
  }

  function flushFrames() {
    const queued = frames;
    frames = [];
    queued.forEach((cb) => cb(0));
  }

  // The reader scrolls the log to `top`.
  function scrollTo(log, top) {
    log.scrollTop = top;
    fireEvent.scroll(log);
  }

  function show(otherProfileId, messages, rerender) {
    mockThread = { data: messages, isLoading: false, isError: false };
    const ui = (
      <MemoryRouter>
        <MessageThread otherProfileId={otherProfileId} otherFullName="Alex" />
      </MemoryRouter>
    );
    if (rerender) rerender(ui);
    else return render(ui);
  }

  beforeEach(() => {
    frames = [];
    layout = { clientHeight: 400, scrollHeight: 1000, scrollTop: 0 };
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      frames.push(cb);
      return frames.length;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openThread() {
    const history = [msg('m1', 'other'), msg('m2', 'me')];
    const view = show('other', history);
    const log = screen.getByRole('log');
    giveLayout(log);
    flushFrames();
    return { ...view, log, history };
  }

  it('opens at the bottom of the thread', () => {
    const { log } = openThread();
    expect(log.scrollTop).toBe(600);
  });

  it('a reader scrolled up into the history stays there when the other side writes', () => {
    const { log, history, rerender } = openThread();
    scrollTo(log, 100);

    layout.scrollHeight = 1100;
    show('other', [...history, msg('m3', 'other')], rerender);
    flushFrames();

    expect(log.scrollTop).toBe(100);
  });

  it('a reader at the bottom follows the new message', () => {
    const { log, history, rerender } = openThread();
    scrollTo(log, 560); // 40px from the end

    layout.scrollHeight = 1100;
    show('other', [...history, msg('m3', 'other')], rerender);
    flushFrames();

    expect(log.scrollTop).toBe(700);
  });

  it('a message of mine scrolls to it, even from up in the history', () => {
    const { log, history, rerender } = openThread();
    scrollTo(log, 100);

    layout.scrollHeight = 1100;
    show('other', [...history, msg('m3', 'me')], rerender);
    flushFrames();

    expect(log.scrollTop).toBe(700);
  });

  it('another counterpart opens at the bottom of their thread, wherever the last one was left', () => {
    const { log, rerender } = openThread();
    scrollTo(log, 100);

    const other2 = [msg('x1', 'other2'), msg('x2', 'other2')];
    layout.scrollHeight = 1500;
    show('other2', other2, rerender);
    flushFrames();
    expect(log.scrollTop).toBe(1100);

    // The reader has not scrolled since: they are at the bottom of this one.
    layout.scrollHeight = 1600;
    show('other2', [...other2, msg('x3', 'other2')], rerender);
    flushFrames();
    expect(log.scrollTop).toBe(1200);
  });
});
