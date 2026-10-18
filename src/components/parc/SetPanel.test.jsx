import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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

  describe('figures that do not hold side by side', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    // The row is measured after layout: a ResizeObserver stands in for the
    // browser's, and the row is 302px wide with 330px of figures in it — what
    // « 12 » and « PDC » ask at 124px on a phone 360px wide.
    function measuredRow({ client, scroll }) {
      const observers = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback) {
            this.callback = callback;
            observers.push(this);
          }
          observe() {}
          disconnect() {}
        },
      );
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
      return () => act(() => observers.forEach((o) => o.callback([])));
    }

    it('draws both at numeral-lg, and never breaks a figure', () => {
      const layout = measuredRow({ client: 302, scroll: 330 });
      render(<SetPanel title="Tractions" primary={{ value: '12', unit: 'répétitions' }} secondary={{ value: 'PDC', unit: 'poids du corps' }} />);
      expect(screen.getByText('PDC')).toHaveClass('pk-numeral-hero', 'whitespace-nowrap');
      layout();
      expect(screen.getByText('12')).toHaveClass('pk-numeral-lg');
      expect(screen.getByText('PDC')).toHaveClass('pk-numeral-lg');
    });

    it('gives the next figures their size again', () => {
      const layout = measuredRow({ client: 302, scroll: 330 });
      const { rerender } = render(<SetPanel title="Tractions" primary={{ value: '12', unit: 'répétitions' }} secondary={{ value: '100', unit: 'kg' }} />);
      layout();
      expect(screen.getByText('100')).toHaveClass('pk-numeral-lg');
      rerender(<SetPanel title="Tractions" primary={{ value: '5', unit: 'répétitions' }} secondary={{ value: '20', unit: 'kg' }} />);
      expect(screen.getByText('20')).toHaveClass('pk-numeral-hero');
    });

    it('keeps the hero size when the row holds', () => {
      const layout = measuredRow({ client: 318, scroll: 318 });
      render(<SetPanel title="Tractions" primary={{ value: '12', unit: 'répétitions' }} secondary={{ value: '100', unit: 'kg' }} />);
      layout();
      expect(screen.getByText('12')).toHaveClass('pk-numeral-hero');
      expect(screen.getByText('100')).toHaveClass('pk-numeral-hero');
    });
  });

  it('leaves the line of last time out when there is none', () => {
    const { container } = render(<SetPanel title="Dips" primary={{ value: '6', unit: 'répétitions' }} />);
    expect(container.querySelector('.border-t')).toBeNull();
  });
});
