import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    render(<MessageComposer recipientProfileId="r1" />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('enables Send and calls mutate with trimmed body on submit', async () => {
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" />);
    const ta = screen.getByLabelText(/type a message/i);
    await user.type(ta, '  hello world  ');
    const sendBtn = screen.getByRole('button', { name: /send/i });
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
    render(<MessageComposer recipientProfileId="r1" />);
    const ta = screen.getByLabelText(/type a message/i);
    await user.type(ta, 'first');
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(mockSend.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).toHaveBeenCalledTimes(1);
  });

  it('disables the textarea when no recipient is set', () => {
    render(<MessageComposer recipientProfileId={null} />);
    expect(screen.getByLabelText(/type a message/i)).toBeDisabled();
  });

  it('offline: disables Send, keeps the draft, and shows the offline hint', async () => {
    // Sending is online-only (useSendMessage has no offline mutation lane) —
    // without this gate an offline send hangs on "Sending…" and is silently
    // dropped by the next reload.
    mockOnline = false;
    const user = userEvent.setup();
    render(<MessageComposer recipientProfileId="r1" />);
    const ta = screen.getByLabelText(/type a message/i);
    await user.type(ta, 'still here?');

    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);

    // Enter must not fire the mutation either.
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(mockSend.mutate).not.toHaveBeenCalled();
    // The typed draft stays in the box for when the connection returns.
    expect(ta).toHaveValue('still here?');
  });
});
