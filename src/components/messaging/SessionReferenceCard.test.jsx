import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { inTimeZone, ZONES } from '../../test/inTimeZone';
import SessionReferenceCard from './SessionReferenceCard';

// The card above a feedback message (design/parc/screens/Conversation.dc.html):
// « About the session », its title, the day it was planned for; a tap opens
// it. The thread decides where (MessageThread.test.jsx).
describe('SessionReferenceCard', () => {
  it('names the session it opens, and says what it is', () => {
    render(<SessionReferenceCard session={{ title: 'Lower A', scheduled_date: '2026-10-17' }} onOpen={() => {}} />);
    const card = screen.getByRole('button', { name: 'Open the session Lower A' });
    expect(card).toHaveTextContent('About the session');
    expect(card).toHaveTextContent('Lower A');
    expect(card).toHaveTextContent('Saturday, October 17');
  });

  it.each(ZONES)('the planned day is the calendar day, in every zone (%s)', (zone) => {
    inTimeZone(zone, () => {
      render(<SessionReferenceCard session={{ title: 'Lower A', scheduled_date: '2026-10-17' }} onOpen={() => {}} />);
      expect(screen.getByText('Saturday, October 17')).toBeInTheDocument();
    });
  });

  it('an untitled session is "Session", and one without a day has no date', () => {
    render(<SessionReferenceCard session={{ title: '  ', scheduled_date: null }} onOpen={() => {}} />);
    const card = screen.getByRole('button', { name: 'Open the session Session' });
    expect(card).toHaveTextContent(/^About the sessionSession$/);
  });

  it('is drawn while the session is on its way, so it does not move', () => {
    render(<SessionReferenceCard session={null} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open the session Session' })).toHaveTextContent('About the session');
  });

  it('a tap opens it', async () => {
    const onOpen = vi.fn();
    render(<SessionReferenceCard session={{ title: 'Lower A' }} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open the session Lower A' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
