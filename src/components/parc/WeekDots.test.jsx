import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import WeekDots from './WeekDots';

describe('WeekDots', () => {
  it('is one image of seven dots, named by the sentence of the week', () => {
    render(
      <WeekDots
        days={['done', 'none', 'done', 'today', 'none', 'next', 'none']}
        label="Cette semaine : lundi et mercredi faits, séance prévue aujourd'hui"
      />,
    );
    const week = screen.getByRole('img', { name: "Cette semaine : lundi et mercredi faits, séance prévue aujourd'hui" });
    const dots = [...week.children];
    expect(dots).toHaveLength(7);
    expect(dots.map((dot) => dot.className)).toEqual(['is-done', '', 'is-done', 'is-today', '', 'is-next', '']);
    expect(week).toHaveClass('pk-week');
  });
});
