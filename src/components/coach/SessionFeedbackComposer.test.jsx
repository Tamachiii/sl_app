import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

// Review item P47: "Finish without feedback" stamped the session reviewed —
// one-shot — whatever the box held, and the text lived in component state
// alone, so it also died with the page. These tests hold the composer to: a
// draft kept per session until it is sent, emptied or discarded on purpose,
// and a question before a typed draft is thrown away.

const mockSend = { mutate: vi.fn(), isPending: false };
const mockMarkReviewed = { mutate: vi.fn(), isPending: false };
const mockNavigate = vi.fn();
let mockOnline = true;

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));
vi.mock('../../hooks/useMessages', () => ({
  useSendMessage: () => mockSend,
  formatMessageStamp: () => 'Apr 30',
}));
vi.mock('../../hooks/useSession', () => ({
  useMarkSessionReviewed: () => mockMarkReviewed,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

import SessionFeedbackComposer from './SessionFeedbackComposer';

const KEY_A = 'sl_feedback_draft:sess-a';
const onFinish = vi.fn();

function composer(sessionId = 'sess-a', props = {}) {
  return (
    <SessionFeedbackComposer
      key={sessionId}
      sessionId={sessionId}
      studentProfileId="p-1"
      studentFullName="Sam"
      onFinish={onFinish}
      {...props}
    />
  );
}

const box = () => screen.getByRole('textbox');
const type = (value) => fireEvent.change(box(), { target: { value } });
const sendButton = () => screen.getByRole('button', { name: 'Send the feedback' });
const finishButton = () => screen.getByRole('button', { name: 'Finish without feedback' });
const discardButton = () => screen.queryByRole('button', { name: 'Finish and discard' });
// The question is a Parc ConfirmSheet: a <dialog> named by its title, shown
// only while it asks.
const finishQuestion = () => screen.queryByRole('dialog', { name: 'Finish without sending?' });
// What the feedback just sent leaves: its end of the review.
function sendIt(text = 'Brace harder') {
  type(text);
  fireEvent.click(sendButton());
  act(() => mockSend.mutate.mock.calls.at(-1)[1].onSuccess());
}

beforeEach(() => {
  mockSend.mutate.mockReset();
  mockMarkReviewed.mutate.mockReset();
  mockNavigate.mockReset();
  onFinish.mockReset();
  mockOnline = true;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<SessionFeedbackComposer />', () => {
  describe('"Finish without feedback"', () => {
    it('finishes at once when nothing is typed', () => {
      render(composer());
      fireEvent.click(finishButton());

      expect(finishQuestion()).toBeNull();
      expect(discardButton()).toBeNull();
      expect(mockMarkReviewed.mutate).toHaveBeenCalledTimes(1);
      expect(mockMarkReviewed.mutate.mock.calls[0][0]).toEqual({ sessionId: 'sess-a' });
      mockMarkReviewed.mutate.mock.calls[0][1].onSettled();
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('finishes at once when the box holds nothing but blanks', () => {
      render(composer());
      type('   \n ');
      fireEvent.click(finishButton());

      expect(discardButton()).toBeNull();
      expect(mockMarkReviewed.mutate).toHaveBeenCalledTimes(1);
    });

    it('asks first when something is typed, and Cancel keeps the text', () => {
      render(composer());
      type('Good depth on the dips.');
      fireEvent.click(finishButton());

      expect(finishQuestion()).toBeInTheDocument();
      expect(finishQuestion()).toHaveTextContent('What you typed has not been sent.');
      expect(discardButton()).toBeInTheDocument();
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(finishQuestion()).toBeNull();
      expect(discardButton()).toBeNull();
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
      expect(box()).toHaveValue('Good depth on the dips.');
      expect(localStorage.getItem(KEY_A)).toBe('Good depth on the dips.');
    });

    it('forgets the draft and finishes once the coach confirms', () => {
      render(composer());
      type('Good depth on the dips.');
      fireEvent.click(finishButton());
      fireEvent.click(discardButton());

      expect(localStorage.getItem(KEY_A)).toBeNull();
      expect(mockMarkReviewed.mutate).toHaveBeenCalledTimes(1);
      expect(mockMarkReviewed.mutate.mock.calls[0][0]).toEqual({ sessionId: 'sess-a' });
      mockMarkReviewed.mutate.mock.calls[0][1].onSettled();
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('asks about a draft read back from the device too', () => {
      localStorage.setItem(KEY_A, 'Typed yesterday');
      render(composer());
      fireEvent.click(finishButton());

      expect(discardButton()).toBeInTheDocument();
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
    });
  });

  describe('the draft', () => {
    it('is kept as it is typed and read back when the composer comes back', () => {
      const view = render(composer());
      type('Brace harder');
      expect(localStorage.getItem(KEY_A)).toBe('Brace harder');

      view.unmount();
      render(composer());
      expect(box()).toHaveValue('Brace harder');
    });

    it('belongs to its session', () => {
      localStorage.setItem(KEY_A, 'About session A');
      render(composer('sess-b'));
      expect(box()).toHaveValue('');
    });

    it('goes when the box is emptied', () => {
      render(composer());
      type('Brace harder');
      type('');
      expect(localStorage.getItem(KEY_A)).toBeNull();

      type('Brace');
      type('   ');
      expect(localStorage.getItem(KEY_A)).toBeNull();
    });

    it('goes once the feedback is sent, and stays when the send fails', () => {
      render(composer());
      type('Brace harder');
      fireEvent.click(sendButton());

      expect(mockSend.mutate).toHaveBeenCalledTimes(1);
      expect(mockSend.mutate.mock.calls[0][0]).toEqual({
        recipientProfileId: 'p-1',
        body: 'Brace harder',
        sessionId: 'sess-a',
      });
      const { onSuccess, onError } = mockSend.mutate.mock.calls[0][1];

      act(() => onError(new Error('network down')));
      expect(localStorage.getItem(KEY_A)).toBe('Brace harder');

      act(() => onSuccess());
      expect(localStorage.getItem(KEY_A)).toBeNull();
    });
  });

  describe('the feedback sent', () => {
    it('says so, and where it is', () => {
      render(composer());
      sendIt();
      expect(screen.getByRole('heading', { level: 2, name: 'Feedback sent' })).toBeInTheDocument();
      expect(screen.getByText('It is in the athlete’s messages.')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    // Sending is the review's end: its "Close the review" stamps the session
    // reviewed (a no-op once the feedback has done it) and leaves.
    it('asks nothing on "Close the review"', () => {
      render(composer());
      sendIt();
      fireEvent.click(screen.getByRole('button', { name: 'Close the review' }));

      expect(discardButton()).toBeNull();
      expect(mockMarkReviewed.mutate).toHaveBeenCalledTimes(1);
      expect(mockMarkReviewed.mutate.mock.calls[0][0]).toEqual({ sessionId: 'sess-a' });
      mockMarkReviewed.mutate.mock.calls[0][1].onSettled();
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('opens the conversation with the athlete', () => {
      render(composer());
      sendIt();
      fireEvent.click(screen.getByRole('button', { name: 'Open the conversation' }));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/messages/p-1');
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('is named after the athlete, or not', () => {
      const view = render(composer());
      expect(screen.getByRole('textbox', { name: 'Your feedback to Sam' })).toBeInTheDocument();
      view.unmount();
      render(composer('sess-a', { studentFullName: null }));
      expect(screen.getByRole('textbox', { name: 'Your feedback' })).toBeInTheDocument();
    });

    it('sends the text without its blanks', () => {
      render(composer());
      expect(sendButton()).toBeDisabled();
      type('  \n ');
      expect(sendButton()).toBeDisabled();
      type('  Brace harder \n');
      fireEvent.click(sendButton());
      expect(mockSend.mutate.mock.calls[0][0]).toEqual({
        recipientProfileId: 'p-1',
        body: 'Brace harder',
        sessionId: 'sess-a',
      });
    });

    it('needs the athlete to send to', () => {
      render(composer('sess-a', { studentProfileId: null }));
      type('Brace harder');
      expect(sendButton()).toBeDisabled();
    });

    it('holds a text too long, and says so', () => {
      render(composer());
      type('x'.repeat(4001));
      expect(sendButton()).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent('Message too long (max 4000 chars).');
      expect(box()).toHaveAttribute('aria-invalid', 'true');
    });

    it('says the send failed, and keeps the text', () => {
      render(composer());
      type('Brace harder');
      fireEvent.click(sendButton());
      act(() => mockSend.mutate.mock.calls[0][1].onError(new Error('')));
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t send the feedback. Try again.');
      expect(box()).toHaveValue('Brace harder');
    });

    it('is held while it is on its way', () => {
      mockSend.isPending = true;
      try {
        render(composer());
        type('Brace harder');
        expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
      } finally {
        mockSend.isPending = false;
      }
    });
  });

  // useSendMessage and useMarkSessionReviewed are not queued offline: a
  // submit would hang on "Sending…", and a reload would drop it.
  it('neither sends nor finishes offline, with or without a draft', () => {
    mockOnline = false;
    render(composer());
    type('Brace harder');
    expect(screen.getByRole('status')).toHaveTextContent(/You’re offline/);
    expect(sendButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();
    fireEvent.click(finishButton());
    fireEvent.submit(box().form);

    expect(discardButton()).toBeNull();
    expect(mockSend.mutate).not.toHaveBeenCalled();
    expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY_A)).toBe('Brace harder');
  });

  // Live finding N14's neighbours: the composer's actions are buttons a thumb
  // has to hit — Parc buttons (44px, test/hitTargets.test.js), in the
  // ActionBar at the bottom of the review (design/parc/screens/Revue.dc.html).
  it('puts its actions in an ActionBar, as Parc buttons', () => {
    render(composer());
    expect(sendButton()).toHaveClass('pk-btn', 'pk-btn-primary', 'pk-btn-lg');
    expect(sendButton()).toHaveAttribute('type', 'submit');
    expect(sendButton()).toHaveAttribute('form', box().form.id);
    expect(finishButton()).toHaveClass('pk-btn');
    expect(sendButton().closest('.pk-actionbar')).toContainElement(finishButton());

    sendIt();
    const close = screen.getByRole('button', { name: 'Close the review' });
    expect(close).toHaveClass('pk-btn', 'pk-btn-primary');
    expect(close.closest('.pk-actionbar')).toContainElement(
      screen.getByRole('button', { name: 'Open the conversation' }),
    );
  });

  // A private window, a full or refused storage: the coach still types and
  // sends, the draft is only not kept.
  it('keeps working when the device storage throws', () => {
    const refuse = () => { throw new Error('SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse);

    render(composer());
    expect(box()).toHaveValue('');
    type('Brace harder');
    expect(box()).toHaveValue('Brace harder');
    type('');
    type('Brace harder');

    fireEvent.click(sendButton());
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
    expect(() => act(() => mockSend.mutate.mock.calls[0][1].onSuccess())).not.toThrow();
    expect(screen.getByText('Feedback sent')).toBeInTheDocument();
  });
});
