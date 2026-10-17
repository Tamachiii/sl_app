import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SetPanel from './SetPanel';

describe('SetPanel', () => {
  it('names the set, shows the two figures over their units and the line of last time', () => {
    render(
      <SetPanel
        label="Série en cours"
        title="Tractions lestées"
        position="Série 3 sur 4"
        primary={{ value: 5, unit: 'répétitions' }}
        secondary={{ value: '20', unit: 'kg de lest' }}
        footer="Il y a 7 jours, 4 × 5 à 17,5 kg."
      />,
    );
    const panel = screen.getByRole('region', { name: 'Série en cours' });
    expect(panel).toHaveClass('pk-panel');
    expect(screen.getByRole('heading', { level: 2, name: 'Tractions lestées' })).toBeInTheDocument();
    expect(screen.getByText('Série 3 sur 4')).toBeInTheDocument();
    expect(screen.getByText('5')).toHaveClass('pk-numeral-hero');
    expect(screen.getByText('20')).toHaveClass('pk-numeral-hero');
    expect(screen.getByText('répétitions')).toBeInTheDocument();
    expect(screen.getByText('Il y a 7 jours, 4 × 5 à 17,5 kg.')).toHaveClass('border-t');
  });

  it('draws a figure longer than three characters at numeral-lg', () => {
    render(<SetPanel title="Dips" primary={{ value: '6', unit: 'répétitions' }} secondary={{ value: '22,5', unit: 'kg de lest' }} />);
    expect(screen.getByText('22,5')).toHaveClass('pk-numeral-lg');
    expect(screen.getByText('22,5')).not.toHaveClass('pk-numeral-hero');
    expect(screen.getByText('6')).toHaveClass('pk-numeral-hero');
  });

  it('leaves the line of last time out when there is none', () => {
    const { container } = render(<SetPanel title="Dips" primary={{ value: '6', unit: 'répétitions' }} />);
    expect(container.querySelector('.border-t')).toBeNull();
  });
});
