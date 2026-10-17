import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TypeBadge from './TypeBadge';
import { I18nProvider } from '../../hooks/useI18n';

const classesOf = (element) => [...element.classList].sort();
// The mark before the name: the colour of the type, hidden from a screen
// reader, which reads the name.
const markOf = (badge) => badge.querySelector('[aria-hidden="true"]');

describe('<TypeBadge />', () => {
  it('draws pull in the pull colour, under its name', () => {
    render(<TypeBadge type="pull" />);
    const badge = screen.getByText('Pull');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveClass('text-ink-2');
    expect(markOf(badge)).toHaveClass('bg-chart-pull', 'rounded-full');
    expect(markOf(badge)).not.toHaveClass('bg-chart-push');
  });

  it('draws push in the push colour, under its name', () => {
    render(<TypeBadge type="push" />);
    const badge = screen.getByText('Push');
    expect(badge).toHaveClass('text-ink-2');
    expect(markOf(badge)).toHaveClass('bg-chart-push');
    expect(markOf(badge)).not.toHaveClass('bg-chart-pull');
  });

  it('draws a type it does not know neutral, under its own name — not as a push', () => {
    // The four hand-written badges were `type === 'pull' ? pull : push`.
    render(<TypeBadge type="legs" />);
    const badge = screen.getByText('legs');
    expect(classesOf(markOf(badge))).toContain('bg-ink-3');
    expect(badge.className).not.toMatch(/push|pull/);
    expect(markOf(badge).className).not.toMatch(/push|pull/);
  });

  it.each([[null], [undefined], ['']])('draws nothing for no type (%j)', (type) => {
    const { container } = render(<TypeBadge type={type} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('adds the classes of its caller to the badge', () => {
    render(<TypeBadge type="pull" className="shrink-0 ml-auto" />);
    const badge = screen.getByText('Pull');
    expect(badge).toHaveClass('shrink-0', 'ml-auto', 'text-ink-2');
    expect(markOf(badge)).toHaveClass('bg-chart-pull');
  });

  it.each([
    ['fr', 'pull', 'Tirer', 'bg-chart-pull'],
    ['fr', 'push', 'Pousser', 'bg-chart-push'],
    ['de', 'pull', 'Zug', 'bg-chart-pull'],
    ['de', 'push', 'Druck', 'bg-chart-push'],
  ])('names the type in the language of the app (%s, %s)', (lang, type, label, mark) => {
    localStorage.setItem('sl_app_lang', lang);
    try {
      render(
        <I18nProvider>
          <TypeBadge type={type} />
        </I18nProvider>,
      );
      expect(markOf(screen.getByText(label))).toHaveClass(mark);
    } finally {
      localStorage.removeItem('sl_app_lang');
    }
  });
});
