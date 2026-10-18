import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockSend = { mutate: vi.fn(), isPending: false };
vi.mock('../../hooks/useMessages', () => ({
  useSendMessage: () => mockSend,
}));

let mockOnline = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

import MessageComposer from './MessageComposer';

describe('MessageComposer', () => {
  beforeEach(() => {
    mockSend = { mutate: vi.fn(), isPending: false };
    mockOnline = true;
  });

  it('disables Send while the textarea is empty', () => {
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables Send and calls mutate with trimmed body on submit', async () => {
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, '  hello world  ');
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).not.toBeDisabled();
    await user.click(sendBtn);
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
    expect(mockSend.mutate.mock.calls[0][0]).toEqual({
      recipientProfileId: 'r1',
      body: 'hello world',
    });
  });

  it('Enter sends, Shift+Enter inserts a newline', async () => {
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, 'first');
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(mockSend.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
  });

  it('an Enter that confirms an IME conversion sends nothing', async () => {
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, 'にほん');
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    // Safari: the composition is over by the time its Enter arrives, keyCode 229.
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 });
    expect(mockSend.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
  });

  describe('on a touch screen (pointer: coarse)', () => {
    const fineMatchMedia = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = (query) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      });
    });
    afterEach(() => {
      window.matchMedia = fineMatchMedia;
    });

    it('Enter inserts a newline and only the button sends', async () => {
      const user = userEvent.setup();
      render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
      const ta = screen.getByLabelText('Message for Alex');
      await user.type(ta, 'a{Enter}b');
      expect(ta).toHaveValue('a\nb');
      expect(mockSend.mutate).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(mockSend.mutate).toHaveBeenCalledTimes(1);
      expect(mockSend.mutate.mock.calls[0][0]).toEqual({ recipientProfileId: 'r1', body: 'a\nb' });
    });

    it('offline, the button still sends nothing', async () => {
      mockOnline = false;
      const user = userEvent.setup();
      render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
      const ta = screen.getByLabelText('Message for Alex');
      await user.type(ta, 'a{Enter}b');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(mockSend.mutate).not.toHaveBeenCalled();
      expect(ta).toHaveValue('a\nb');
    });
  });

  it('disables the textarea when no recipient is set', () => {
    render(<MessageComposer recipientProfileId={null} />);
    expect(screen.getByLabelText('Write a message')).toBeDisabled();
  });

  it('names the field after the recipient, and writes to them in the placeholder', () => {
    render(<MessageComposer recipientProfileId="r1" recipientName="  Alex  " />);
    expect(screen.getByRole('textbox', { name: 'Message for Alex' })).toHaveAttribute('placeholder', 'Write to Alex');
  });

  it('without a name, the field is "Write a message"', () => {
    render(<MessageComposer recipientProfileId="r1" recipientName=" " />);
    expect(screen.getByRole('textbox', { name: 'Write a message' })).toHaveAttribute('placeholder', 'Write a message');
  });

  it('the send button is round and says "Sending…" while a message is on its way', () => {
    mockSend = { mutate: vi.fn(), isPending: true };
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const button = screen.getByRole('button', { name: 'Sending…' });
    expect(button).toBeDisabled();
    expect(button).toHaveClass('pk-btn-primary', 'rounded-full', 'h-11', 'w-11');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('a message past 4000 characters says so and cannot be sent', () => {
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    fireEvent.change(ta, { target: { value: 'a'.repeat(4001) } });
    expect(screen.getByRole('alert')).toHaveTextContent('Message too long, 4000 characters at most.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).not.toHaveBeenCalled();

    fireEvent.change(ta, { target: { value: 'a'.repeat(4000) } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  it('a send that fails says why and keeps the text; typing again clears the error', async () => {
    const user = userEvent.setup();
    mockSend.mutate.mockImplementation((_vars, { onError }) => onError(new Error('Network down')));
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
    expect(ta).toHaveValue('hello');

    await user.type(ta, '!');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failure without a message falls back to a sentence of its own', async () => {
    const user = userEvent.setup();
    mockSend.mutate.mockImplementation((_vars, { onError }) => onError(null));
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    await user.type(screen.getByLabelText('Message for Alex'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t send the message. Try again.');
  });

  it('a message sent empties the box', async () => {
    const user = userEvent.setup();
    mockSend.mutate.mockImplementation((_vars, { onSuccess }) => onSuccess());
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(ta).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offline: disables Send, keeps the draft, and shows the offline hint', async () => {
    // Sending is online-only (useSendMessage has no offline mutation lane) —
    // without this gate an offline send hangs on "Sending…" and is silently
    // dropped by the next reload.
    mockOnline = false;
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" recipientName="Alex" />);
    const ta = screen.getByLabelText('Message for Alex');
    await user.type(ta, 'still here?');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);

    // Enter must not fire the mutation either.
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).not.toHaveBeenCalled();
    // The typed draft stays in the box for when the connection returns.
    expect(ta).toHaveValue('still here?');
  });
});
