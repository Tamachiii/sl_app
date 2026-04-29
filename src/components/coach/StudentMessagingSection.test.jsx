import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StudentMessagingSection from './StudentMessagingSection';

describe('StudentMessagingSection', () => {
  it('renders the coming-soon placeholder', () => {
    render(<StudentMessagingSection />);
    expect(screen.getByText(/messaging is coming soon/i)).toBeInTheDocument();
  });

  it('renders the description copy', () => {
    render(<StudentMessagingSection />);
    expect(screen.getByText(/once the feature ships/i)).toBeInTheDocument();
  });

  it('exposes a labelled region', () => {
    render(<StudentMessagingSection />);
    expect(screen.getByRole('region', { name: 'Messaging' })).toBeInTheDocument();
  });
});
