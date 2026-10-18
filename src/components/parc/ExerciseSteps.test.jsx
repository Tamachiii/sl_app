import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExerciseSteps from './ExerciseSteps';

describe('ExerciseSteps', () => {
  it('is one image of a dot per exercise, named by its sentence', () => {
    render(<ExerciseSteps count={4} current={2} done={[0, 1]} label="Exercice 3 sur 4, 2 terminés" />);
    const steps = screen.getByRole('img', { name: 'Exercice 3 sur 4, 2 terminés' });
    expect(steps).toHaveClass('pk-steps');
    expect([...steps.children].map((dot) => dot.className)).toEqual(['is-done', 'is-done', 'is-current', '']);
  });

  // The exercise shown is told by its shape, whatever was done on it.
  it('draws the exercise shown as the current one, finished or not', () => {
    render(<ExerciseSteps count={2} current={0} done={[0]} label="Exercice 1 sur 2, 1 terminé" />);
    const steps = screen.getByRole('img', { name: 'Exercice 1 sur 2, 1 terminé' });
    expect([...steps.children].map((dot) => dot.className)).toEqual(['is-current', '']);
  });

  it('points at nothing: no control in it', () => {
    render(<ExerciseSteps count={3} current={1} label="Exercice 2 sur 3, 0 terminé" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
