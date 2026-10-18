import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LanguageSelect from './LanguageSelect';
import { I18nProvider } from '../../hooks/useI18n';

// The language of the app, as a Parc segmented control: each language named
// in its own language, the one in use pressed, a tap switches the app.

function renderSelect(props = {}) {
  return render(
    <I18nProvider>
      <LanguageSelect {...props} />
    </I18nProvider>,
  );
}

afterEach(() => {
  localStorage.removeItem('sl_app_lang');
});

describe('<LanguageSelect />', () => {
  it('is a group named by its visible label, each language in its own language', () => {
    localStorage.setItem('sl_app_lang', 'en');
    renderSelect({ label: 'Language' });
    const group = screen.getByRole('group', { name: 'Language' });
    expect(group).toHaveClass('pk-segmented');
    expect(screen.getByText('Language')).toBeVisible();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['English', 'Français', 'Deutsch']);
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Français' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('without a label, the group is still named "Language", in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'en');
    const { unmount } = renderSelect();
    expect(screen.getByRole('group', { name: 'Language' })).toBeInTheDocument();
    unmount();
    localStorage.setItem('sl_app_lang', 'fr');
    renderSelect();
    expect(screen.getByRole('group', { name: 'Langue' })).toBeInTheDocument();
  });

  it('a tap switches the app to that language, and the device keeps it', async () => {
    localStorage.setItem('sl_app_lang', 'en');
    const user = userEvent.setup();
    renderSelect({ label: 'Language' });
    await user.click(screen.getByRole('button', { name: 'Deutsch' }));
    // The page speaks German now: the choice made is pressed, and the
    // segments keep their own names.
    expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('sl_app_lang')).toBe('de');
    expect(document.documentElement).toHaveAttribute('lang', 'de');
  });
});
