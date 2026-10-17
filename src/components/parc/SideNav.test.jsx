import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SideNav, { SideNavItem } from './SideNav';

describe('SideNav', () => {
  it('lists the tabs under the name of the app, the account at the bottom', () => {
    render(
      <MemoryRouter initialEntries={['/coach/students']}>
        <SideNav label="Navigation principale" brand="SL Coach" footer={<button type="button">Menu du compte</button>}>
          <SideNavItem to="/coach/students" icon="athletes" label="Athlètes" />
          <SideNavItem to="/coach/sessions" icon="sessions" label="Séances" count={3} countLabel="3 séances à revoir" />
        </SideNav>
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(nav).toHaveClass('pk-sidenav');
    expect(screen.getByText('SL Coach')).toHaveClass('pk-condensed');
    const athletes = screen.getByRole('link', { name: 'Athlètes' });
    expect(athletes).toHaveAttribute('aria-current', 'page');
    expect(athletes).toHaveClass('pk-sidenav-item');
    expect(screen.getByRole('link', { name: /^Séances ?3 séances à revoir$/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Menu du compte' })).toBeInTheDocument();
  });
});
