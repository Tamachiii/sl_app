import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Spinner from './Spinner';
import { I18nProvider } from '../../hooks/useI18n';

describe('Spinner', () => {
  it('renders with role="status" and aria-label', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute('aria-label', 'Loading');
  });

  it('is named in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    try {
      render(
        <I18nProvider>
          <Spinner />
        </I18nProvider>,
      );
      expect(screen.getByRole('status', { name: 'Chargement' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('sl_app_lang');
    }
  });
});
