import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockThread = { data: [], isLoading: false, isError: false };
const mockMarkRead = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };

vi.mock('../../hooks/useMessages', async () => {
  const actual = await vi.importActual('../../hooks/useMessages');
  return {
    ...actual,
    useMessageThread: () => mockThread,
    useMarkThreadRead: () => mockMarkRead,
    useDeleteMessage: () => mockDelete,
    useSessionRefsForMessages: () => new Map(),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, role: 'coach' }),
}));

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [] }),
}));

vi.mock('./MessageComposer', () => ({
  default: () => <div data-testid="composer" />,
}));

import MessageThread from './MessageThread';

function renderThread(otherProfileId = 'other') {
  return render(
    <MemoryRouter>
      <MessageThread otherProfileId={otherProfileId} otherFullName="Alex" />
    </MemoryRouter>,
  );
}

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

  it('shows "Read · {time}" when the latest outgoing message has read_at', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'hi', read_at: '2026-05-05T10:01:00Z', created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.getByText(/^Read · /)).toBeInTheDocument();
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

describe('MessageThread bubbles', () => {
  it('a long URL wraps inside its bubble instead of widening the thread', () => {
    const url = `https://example.com/${'a'.repeat(300)}`;
    mockThread = { data: [msg('m1', 'other', url)], isLoading: false, isError: false };
    renderThread();
    // overflow-wrap: anywhere — break-words leaves the URL as the bubble's
    // smallest width, which the 80% column then overflows.
    expect(screen.getByText(url)).toHaveClass('wrap-anywhere');
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
