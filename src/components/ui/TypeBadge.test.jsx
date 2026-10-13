import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TypeBadge from './TypeBadge';
import { I18nProvider } from '../../hooks/useI18n';

const classesOf = (element) => [...element.classList].sort();

describe('<TypeBadge />', () => {
  it('draws pull in the pull colour, under its name', () => {
    render(<TypeBadge type="pull" />);
    const badge = screen.getByText('Pull');
    expect(badge.tagName).toBe('SPAN');
    expect(classesOf(badge)).toEqual(['bg-pull/15', 'sl-pill', 'text-pull']);
  });

  it('draws push in the push colour, under its name', () => {
    render(<TypeBadge type="push" />);
    expect(classesOf(screen.getByText('Push'))).toEqual(['bg-push/15', 'sl-pill', 'text-push']);
  });

  it('draws a type it does not know neutral, under its own name — not as a push', () => {
    // The four hand-written badges were `type === 'pull' ? pull : push`.
    render(<TypeBadge type="legs" />);
    const badge = screen.getByText('legs');
    expect(classesOf(badge)).toEqual(['bg-ink-100', 'sl-pill', 'text-ink-500']);
    expect(badge.className).not.toMatch(/push|pull/);
  });

  it.each([[null], [undefined], ['']])('draws nothing for no type (%j)', (type) => {
    const { container } = render(<TypeBadge type={type} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('adds the classes of its caller to the pill', () => {
    render(<TypeBadge type="pull" className="shrink-0 ml-auto" />);
    expect(classesOf(screen.getByText('Pull'))).toEqual(['bg-pull/15', 'ml-auto', 'shrink-0', 'sl-pill', 'text-pull']);
  });

  it.each([
    ['fr', 'pull', 'Tirer'],
    ['fr', 'push', 'Pousser'],
    ['de', 'pull', 'Zug'],
    ['de', 'push', 'Druck'],
  ])('names the type in the language of the app (%s, %s)', (lang, type, label) => {
    localStorage.setItem('sl_app_lang', lang);
    try {
      render(
        <I18nProvider>
          <TypeBadge type={type} />
        </I18nProvider>,
      );
      expect(screen.getByText(label)).toHaveClass('sl-pill');
    } finally {
      localStorage.removeItem('sl_app_lang');
    }
  });
});
