import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OfflineBanner from './OfflineBanner';
import { AA_TEXT, contrastRatio } from '../../test/contrast.js';

// The banner is mounted at the top of the scrolling <main> of AppShell. It
// used to scroll away with the page: half-way down a session, an athlete
// without signal saw nothing that said so. It is sticky now, and jsdom has no
// layout to scroll — so what is held here is the style the wrapper is given,
// and the things about its place that the style depends on. The behaviour
// itself was measured in Chromium (see the commit that added this file).

const here = dirname(fileURLToPath(import.meta.url));
const source = (file) => readFileSync(resolve(here, file), 'utf8');

const onLine = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'onLine');
function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}
afterEach(() => {
  delete navigator.onLine;
  if (onLine) Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', onLine);
});

function renderBanner({ online }) {
  setOnline(online);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OfflineBanner />
    </QueryClientProvider>,
  );
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
  return screen.getByTestId('offline-banner-wrapper');
}

describe('<OfflineBanner /> stays in view', () => {
  it('is stuck to the top of the box that scrolls it while it shows', () => {
    const wrapper = renderBanner({ online: false });
    expect(wrapper).toHaveAttribute('aria-hidden', 'false');
    expect(wrapper).toHaveStyle({ position: 'sticky', top: '0px' });
    expect(screen.getByTestId('offline-banner')).toHaveTextContent(/offline/i);
  });

  it('is positioned the same while it is folded, so that showing it changes its height and nothing else', () => {
    const wrapper = renderBanner({ online: true });
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper).toHaveStyle({ position: 'sticky', top: '0px', maxHeight: '0px' });
  });

  it('keeps the clipping and the transition that fold it away', () => {
    const wrapper = renderBanner({ online: true });
    expect(wrapper).toHaveStyle({ overflow: 'hidden' });
    expect(wrapper.style.transition).toMatch(/max-height/);
  });

  it('sticks under the notch, not behind it: <main> scrolls it, and pads its own top by the inset', () => {
    // A sticky box is held inside the CONTENT box of its scroller, so `top: 0`
    // is the inner edge of the scroller's padding. AppShell's <main> is that
    // scroller and its top padding is the safe-area inset: 0 is just below
    // the notch, where the banner already sits before any scroll. Were the
    // inset moved off <main>, or the banner wrapped in another scroller, the
    // 0 would mean something else — hence this look at the shell.
    const main = /<main\b([\s\S]*?)<\/main>/.exec(source('../layout/AppShell.jsx'))?.[1] ?? '';
    const at = main.indexOf('<OfflineBanner');
    expect(at).toBeGreaterThan(-1);
    const openingTag = main.slice(0, at);
    expect(openingTag).toMatch(/overflow-y-auto/);
    expect(openingTag).toMatch(/paddingTop:\s*'env\(safe-area-inset-top\)'/);
    // No element opens between <main …> and the banner.
    expect(openingTag).not.toMatch(/<[A-Za-z]/);
    // And the inset is not added a second time by the banner itself.
    expect(source('./OfflineBanner.jsx')).not.toMatch(/top:\s*'env\(/);
  });

  it('lies over the page and its popovers, under the toasts', () => {
    const zIndex = Number(renderBanner({ online: false }).style.zIndex);
    // The layers a page gives its own menus and panels.
    const pageLayers = ['../notifications/NotificationBell.jsx', './UserMenu.jsx', '../coach/SessionRow.jsx']
      .flatMap((file) => [...source(file).matchAll(/\bz-(\d+)\b/g)])
      .map((match) => Number(match[1]));
    expect(pageLayers.length).toBeGreaterThan(0);
    expect(zIndex).toBeGreaterThan(Math.max(...pageLayers));
    const toasts = Number(/\bz-(\d+)\b/.exec(source('./ToastHost.jsx'))?.[1]);
    expect(zIndex).toBeLessThan(toasts);
  });

  it('is opaque and readable: what scrolls under it does not show through its text', () => {
    renderBanner({ online: false });
    const banner = screen.getByTestId('offline-banner');
    // Parc tokens as utilities: amber-soft under ink. No alpha on the class
    // (`bg-amber-soft/80` would let the page show through) and none in the
    // token itself.
    expect(banner).toHaveClass('bg-amber-soft', 'text-ink');
    expect(banner.className).not.toMatch(/\bbg-[\w-]+\/\d+/);
    // The utilities are the Parc tokens themselves.
    const theme = source('../../index.css');
    expect(theme).toMatch(/--color-amber-soft:\s*var\(--amber-soft\);/);
    expect(theme).toMatch(/--color-ink:\s*var\(--ink\);/);
    const parc = source('../../styles/parc-tokens.css');
    const token = (name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(parc)?.[1];
    expect(token('amber-soft')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(token('ink')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(token('ink'), token('amber-soft'))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
