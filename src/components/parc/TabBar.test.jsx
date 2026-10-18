import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TabBar, { Count, Tab } from './TabBar';

function renderAt(path, ui) {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

describe('TabBar', () => {
  it('is a named navigation of tabs, the open one aria-current', () => {
    renderAt(
      '/student/stats',
      <TabBar label="Navigation principale">
        <Tab to="/student" end icon="sessions" label="Entraînement" />
        <Tab to="/student/stats" icon="stats" label="Stats" />
      </TabBar>,
    );
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(nav).toHaveClass('pk-tabbar');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Entraînement' })).not.toHaveAttribute('aria-current');
    for (const link of screen.getAllByRole('link')) expect(link).toHaveClass('pk-tab');
  });

  it('follows `active` when the tab says it, whatever the path', () => {
    renderAt(
      '/coach/student/1/session/2/review',
      <TabBar label="Navigation principale">
        <Tab to="/coach/sessions" active icon="sessions" label="Séances" />
        <Tab to="/coach/students" active={false} icon="athletes" label="Athlètes" />
      </TabBar>,
    );
    expect(screen.getByRole('link', { name: 'Séances' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Athlètes' })).not.toHaveAttribute('aria-current');
  });

  it('puts a count on the icon, said in a sentence', () => {
    renderAt(
      '/',
      <TabBar label="Navigation principale">
        <Tab to="/coach/sessions" icon="sessions" label="Séances" count={2} countLabel="2 séances à revoir" />
      </TabBar>,
    );
    const link = screen.getByRole('link', { name: /^Séances ?2 séances à revoir$/ });
    expect(link.querySelector('.pk-count')).not.toBeNull();
  });
});

describe('Count', () => {
  it('writes 99+ past 99, and nothing for 0', () => {
    const { container, rerender } = render(<Count count={120} countLabel="120 séances à revoir" />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('99+');
    expect(screen.getByText('120 séances à revoir')).toHaveClass('sr-only');
    rerender(<Count count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
