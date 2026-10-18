import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import ToastHost from './ToastHost';
import { I18nProvider } from '../../hooks/useI18n';
import { dismissToast, getToasts, pushToast } from '../../lib/toast';
import { AA_TEXT, contrastRatio, declared, readStylesheet } from '../../test/contrast.js';

const LIFETIME = 6000;
const LIFETIME_WITH_ACTION = 8000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Empty the store first, while the host is still mounted and can take it.
  act(() => {
    for (const toast of getToasts()) dismissToast(toast.id);
  });
  vi.useRealTimers();
});

const push = (...args) => {
  let id;
  act(() => {
    id = pushToast(...args);
  });
  return id;
};
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));
const messages = () => getToasts().map((toast) => toast.message);

describe('<ToastHost />', () => {
  it('renders nothing while there is no toast', () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces an error as an alert and anything else as a status', () => {
    render(<ToastHost />);
    push('It failed');
    push('It is saved', { kind: 'info' });
    expect(screen.getByRole('alert')).toHaveTextContent('It failed');
    expect(screen.getByRole('status')).toHaveTextContent('It is saved');
  });

  it('resolves a message that is an i18n key and shows any other as it is', () => {
    render(<ToastHost />);
    push('errors.generic');
    push('Not a key. Just a sentence.', { kind: 'info' });
    expect(screen.getByRole('alert')).not.toHaveTextContent('errors.generic');
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(screen.getByRole('status')).toHaveTextContent('Not a key. Just a sentence.');
  });

  it('closes a toast by itself after its lifetime, and not before', () => {
    render(<ToastHost />);
    push('It failed');
    advance(LIFETIME - 1);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getToasts()).toEqual([]);
  });

  it('closes a toast on its dismiss button', () => {
    render(<ToastHost />);
    push('It failed');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('gives the dismiss button a 44px round box', () => {
    render(<ToastHost />);
    push('It failed');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveClass('pk-icon-btn');
  });

  it('closes an info toast by itself only: it has no dismiss button', () => {
    render(<ToastHost />);
    push('It is saved', { kind: 'info' });
    expect(within(screen.getByRole('status')).queryAllByRole('button')).toEqual([]);
  });
});

describe('<ToastHost />: the clock stops while a toast is read', () => {
  it('stops under the pointer and starts again when it leaves', () => {
    render(<ToastHost />);
    push('It failed');
    advance(4000);
    fireEvent.pointerEnter(screen.getByRole('alert'));
    // Well past the lifetime: still there.
    advance(LIFETIME * 5);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.pointerLeave(screen.getByRole('alert'));
    // What was left when it stopped: 2000 of 6000.
    advance(1999);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves two seconds at least after a pause, however late it came', () => {
    render(<ToastHost />);
    push('It failed');
    advance(LIFETIME - 100);
    fireEvent.pointerEnter(screen.getByRole('alert'));
    advance(60_000);
    fireEvent.pointerLeave(screen.getByRole('alert'));
    advance(1999);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stops while a button of the toast holds the focus', () => {
    render(<ToastHost />);
    push('Not saved', { kind: 'error', action: { label: 'Retry', onClick: () => {} } });
    const toast = screen.getByRole('alert');
    const retry = within(toast).getByRole('button', { name: 'Retry' });
    const dismiss = within(toast).getByRole('button', { name: 'Dismiss' });

    act(() => retry.focus());
    advance(LIFETIME_WITH_ACTION * 5);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // From one button of the toast to the other: the focus has not left it.
    act(() => dismiss.focus());
    advance(LIFETIME_WITH_ACTION * 5);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => dismiss.blur());
    advance(LIFETIME_WITH_ACTION - 1);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays stopped under the pointer when the focus leaves, and the other way round', () => {
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    const toast = screen.getByRole('status');
    const undo = within(toast).getByRole('button', { name: 'Undo' });

    fireEvent.pointerEnter(toast);
    act(() => undo.focus());
    act(() => undo.blur());
    advance(60_000);
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => undo.focus());
    fireEvent.pointerLeave(toast);
    advance(60_000);
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => undo.blur());
    advance(LIFETIME_WITH_ACTION);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stops one toast and lets the others run', () => {
    render(<ToastHost />);
    push('First');
    push('Second', { kind: 'info' });
    fireEvent.pointerEnter(screen.getByRole('alert'));
    advance(LIFETIME);
    expect(messages()).toEqual(['First']);
  });
});

describe('<ToastHost />: a toast with an action', () => {
  it('shows one button with the label, and an error its dismiss button after it', () => {
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    push('Not saved', { kind: 'error', action: { label: 'Retry', onClick: () => {} } });
    const names = (role) =>
      within(screen.getByRole(role))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names('status')).toEqual(['Undo']);
    expect(names('alert')).toEqual(['Retry', 'Dismiss']);
    expect(within(screen.getByRole('status')).getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('has no action button without an action', () => {
    render(<ToastHost />);
    push('It failed');
    expect(within(screen.getByRole('alert')).getAllByRole('button')).toHaveLength(1);
  });

  it('calls the action once and closes', () => {
    const onClick = vi.fn();
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(getToasts()).toEqual([]);
  });

  it('calls the action once when the button is hit twice before the toast is gone', () => {
    const onClick = vi.fn();
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick } });
    const undo = screen.getByRole('button', { name: 'Undo' });
    // Both presses reach the same handler, as two fingers' worth of taps do
    // before the next paint.
    act(() => {
      undo.click();
      undo.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('closes even when the action throws', () => {
    const boom = new Error('undo failed');
    const onError = vi.fn((event) => event.preventDefault());
    window.addEventListener('error', onError);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<ToastHost />);
      push('Set removed', {
        kind: 'info',
        action: {
          label: 'Undo',
          onClick: () => {
            throw boom;
          },
        },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // …and the failure is not swallowed.
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].error).toBe(boom);
    } finally {
      window.removeEventListener('error', onError);
      spy.mockRestore();
    }
  });

  it('calls nothing when the toast is dismissed or runs out', () => {
    const dismissed = vi.fn();
    const expired = vi.fn();
    render(<ToastHost />);
    push('One', { kind: 'error', action: { label: 'Undo one', onClick: dismissed } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    push('Two', { kind: 'info', action: { label: 'Undo two', onClick: expired } });
    advance(LIFETIME_WITH_ACTION);
    expect(getToasts()).toEqual([]);
    expect(dismissed).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
  });

  it('stays longer than a plain toast', () => {
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    advance(LIFETIME);
    expect(screen.getByRole('status')).toBeInTheDocument();
    advance(LIFETIME_WITH_ACTION - LIFETIME - 1);
    expect(screen.getByRole('status')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows two toasts for the same message with two actions, each with its own', () => {
    const undoFirst = vi.fn();
    const undoSecond = vi.fn();
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: undoFirst } });
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: undoSecond } });
    const undoButtons = screen.getAllByRole('button', { name: 'Undo' });
    expect(undoButtons).toHaveLength(2);
    fireEvent.click(undoButtons[1]);
    expect(undoSecond).toHaveBeenCalledTimes(1);
    expect(undoFirst).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undoFirst).toHaveBeenCalledTimes(1);
  });

  it('resolves a label that is an i18n key, in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'de');
    try {
      render(
        <I18nProvider>
          <ToastHost />
        </I18nProvider>,
      );
      push('Satz entfernt', { kind: 'info', action: { label: 'uiSharedHelpers.undo', onClick: () => {} } });
      expect(screen.getByRole('button', { name: 'Rückgängig' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('sl_app_lang');
    }
  });

  it('makes the button a 44px Parc button', () => {
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('pk-btn');
  });

  it('writes the label and the message in colours that reach AA on the toast', () => {
    render(<ToastHost />);
    push('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    expect(screen.getByRole('status')).toHaveClass('pk-toast');
    // The toast is `ink`, its text `surface`, its action `--toast-action`
    // (src/styles/parc-app.css), read off the stylesheets.
    const tokens = readStylesheet('src/styles/parc-tokens.css');
    const app = readStylesheet('src/styles/parc-app.css');
    const ink = declared(tokens, ':root', '--ink');
    expect(declared(app, '.pk-toast', 'background')).toBe('var(--ink)');
    expect(declared(app, '.pk-toast .pk-btn', 'color')).toBe('var(--toast-action)');
    expect(contrastRatio(declared(app, ':root', '--toast-action'), ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(declared(app, ':root', '--toast-error'), ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(declared(tokens, ':root', '--surface'), ink)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
