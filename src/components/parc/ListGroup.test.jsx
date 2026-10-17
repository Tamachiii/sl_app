import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ListGroup, { Avatar, Row } from './ListGroup';
import StatusText from './StatusText';

describe('ListGroup', () => {
  it('is a section named by its title, the list a pk-group under it', () => {
    render(
      <MemoryRouter>
        <ListGroup title="À suivre" aside="4 athlètes">
          <Row to="/coach/students/1" title="Léa Martin" subtitle="Séance 7 sur 24, Force tirage" />
        </ListGroup>
      </MemoryRouter>,
    );
    const section = screen.getByRole('region', { name: 'À suivre' });
    expect(screen.getByRole('heading', { level: 2, name: 'À suivre' })).toHaveClass('pk-headline');
    expect(section.querySelector('ul')).toHaveClass('pk-group');
    expect(screen.getByText('4 athlètes')).toBeInTheDocument();
  });

  it('names an untitled list by its label, as an ordered list when asked', () => {
    render(
      <ListGroup label="Séries" ordered>
        <Row title="Série 1" />
      </ListGroup>,
    );
    const list = screen.getByRole('list', { name: 'Séries' });
    expect(list.tagName).toBe('OL');
  });
});

describe('Row', () => {
  it('a row that leads somewhere is a link with a chevron', () => {
    render(
      <MemoryRouter>
        <ul>
          <Row
            to="/coach/students/1"
            title="Léa Martin"
            subtitle="Séance 7 sur 24"
            leading={<Avatar name="Léa Martin" />}
            trailing={<StatusText tone="review">2 à revoir</StatusText>}
          />
        </ul>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/coach/students/1');
    expect(link).toHaveClass('pk-row');
    // The comma between the title and the second line is for a screen reader.
    expect(link).toHaveAccessibleName('Léa Martin, Séance 7 sur 24, 2 à revoir');
    expect(link.querySelectorAll('svg')).toHaveLength(1);
  });

  it('a row with onClick is a button without a chevron', () => {
    const onClick = vi.fn();
    render(
      <ul>
        <Row onClick={onClick} title="Modifier l'exercice" />
      </ul>,
    );
    const button = screen.getByRole('button', { name: "Modifier l'exercice" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.querySelector('svg')).toBeNull();
  });

  it('a plain row is neither a link nor a button', () => {
    render(
      <ul>
        <Row title="Tractions lestées" subtitle="5 × 5 à 20 kg" />
      </ul>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('5 × 5 à 20 kg')).toHaveClass('pk-caption');
  });
});

describe('Avatar', () => {
  it('draws two initials, hidden from assistive technology', () => {
    const { container } = render(<Avatar name="léa  martin dupont" />);
    expect(container.firstChild).toHaveTextContent('LM');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstChild).toHaveClass('bg-blue-soft', 'text-blue');
  });
});
