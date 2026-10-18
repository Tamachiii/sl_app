import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import Button, { IconButton } from './Button';

describe('Button', () => {
  it('is a button of type button, secondary by default', () => {
    render(<Button>Ajouter</Button>);
    const button = screen.getByRole('button', { name: 'Ajouter' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('pk-btn', 'pk-btn-secondary');
  });

  it.each([
    ['primary', 'pk-btn-primary'],
    ['on-ground', 'pk-btn-on-ground'],
    ['text', 'pk-btn-text'],
    ['danger', 'pk-btn-danger'],
  ])('draws the %s variant with %s', (variant, className) => {
    render(<Button variant={variant}>Action</Button>);
    expect(screen.getByRole('button')).toHaveClass('pk-btn', className);
  });

  it('is the 56px button with size lg, and keeps the classes it is given', () => {
    render(
      <Button variant="primary" size="lg" className="flex-1">
        Valider la série 3
      </Button>,
    );
    expect(screen.getByRole('button')).toHaveClass('pk-btn-primary', 'pk-btn-lg', 'flex-1');
  });

  it('calls onClick and passes disabled through', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders a router link with as={Link}, without a type', () => {
    render(
      <MemoryRouter>
        <Button as={Link} to="/student" variant="text">
          Voir tout le programme
        </Button>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Voir tout le programme' });
    expect(link).toHaveAttribute('href', '/student');
    expect(link).not.toHaveAttribute('type');
    expect(link).toHaveClass('pk-btn', 'pk-btn-text');
  });
});

describe('IconButton', () => {
  it('is a round 44px button named by its label, holding a hidden icon', () => {
    render(<IconButton icon="chevron-left" label="Retour" />);
    const button = screen.getByRole('button', { name: 'Retour' });
    expect(button).toHaveClass('pk-icon-btn');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('sits on fill in a sheet and on nothing in a toast', () => {
    render(
      <>
        <IconButton icon="close" label="Fermer" tone="fill" />
        <IconButton icon="close" label="Ignorer" tone="none" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Fermer' })).toHaveClass('bg-fill');
    expect(screen.getByRole('button', { name: 'Ignorer' })).toHaveClass('bg-transparent');
  });
});
