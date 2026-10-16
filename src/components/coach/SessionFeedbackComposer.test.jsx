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

function composer(sessionId = 'sess-a') {
  return (
    <SessionFeedbackComposer
      key={sessionId}
      sessionId={sessionId}
      studentProfileId="p-1"
      studentFullName="Sam"
      onFinish={onFinish}
    />
  );
}

const box = () => screen.getByRole('textbox');
const type = (value) => fireEvent.change(box(), { target: { value } });
const finishButton = () => screen.getByRole('button', { name: 'Finish without feedback' });
const discardButton = () => screen.queryByRole('button', { name: 'Finish and discard' });

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

      expect(screen.getByText('Finish without sending?')).toBeInTheDocument();
      expect(discardButton()).toBeInTheDocument();
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

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
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

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

  it('asks nothing on the sent card’s "Back to sessions"', () => {
    render(composer());
    type('Brace harder');
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    // The answer arrives: the card says the feedback was sent.
    const { onSuccess } = mockSend.mutate.mock.calls[0][1];
    act(() => onSuccess());

    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));

    expect(discardButton()).toBeNull();
    expect(mockMarkReviewed.mutate).toHaveBeenCalledTimes(1);
  });

  it('does not finish offline, with or without a draft', () => {
    mockOnline = false;
    render(composer());
    type('Brace harder');
    fireEvent.click(finishButton());

    expect(discardButton()).toBeNull();
    expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY_A)).toBe('Brace harder');
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

    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
    expect(() => act(() => mockSend.mutate.mock.calls[0][1].onSuccess())).not.toThrow();
    expect(screen.getByText('Feedback sent.')).toBeInTheDocument();
  });
});
