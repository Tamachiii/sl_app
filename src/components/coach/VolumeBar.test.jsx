import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VolumeBar from './VolumeBar';

describe('VolumeBar', () => {
  it('renders pull and push labels with values', () => {
    render(<VolumeBar pull={60} push={40} />);
    expect(screen.getByText(/Pull 60/)).toBeInTheDocument();
    expect(screen.getByText(/Push 40/)).toBeInTheDocument();
  });

  it('returns null when total is 0', () => {
    const { container } = render(<VolumeBar pull={0} push={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only pull bar when push is 0', () => {
    render(<VolumeBar pull={100} push={0} />);
    expect(screen.getByText(/Pull 100/)).toBeInTheDocument();
    expect(screen.getByText(/Push 0/)).toBeInTheDocument();
  });
});
