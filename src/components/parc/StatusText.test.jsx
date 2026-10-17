import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusText from './StatusText';

describe('StatusText', () => {
  it.each([
    ['review', '2 à revoir', 'text-blue'],
    ['quiet', 'Silencieux 9 j', 'text-amber'],
    ['alert', 'Sans programme', 'text-red'],
  ])('writes %s as a word in its colour', (tone, text, className) => {
    render(<StatusText tone={tone}>{text}</StatusText>);
    expect(screen.getByText(text)).toHaveClass(className, 'font-bold', 'text-[14px]');
    expect(screen.getByText(text)).not.toHaveClass('uppercase');
  });
});
