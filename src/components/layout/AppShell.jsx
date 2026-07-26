import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import BottomNav from './BottomNav';
import SideNav from './SideNav';
import OfflineBanner from '../ui/OfflineBanner';
import ToastHost from '../ui/ToastHost';
import { useMessagesRealtime } from '../../hooks/useMessages';
import { useNotificationsRealtime } from '../../hooks/useNotifications';
import { resumeMutationsAndReconcileDrafts } from '../../lib/offlineMutations';

/**
 * Keep `--kb-inset` on the document root in sync with the soft keyboard's
 * height. Pages with bottom-anchored UI (Messages thread composer) read it
 * to lift content above the keyboard.
 *
 * On browsers that honor `interactive-widget=resizes-content` (iOS 17+,
 * Chrome 108+) the layout viewport itself reflows when the keyboard opens,
 * so `visualViewport.height === window.innerHeight` and `inset` stays 0.
 * On older iOS, the layout viewport doesn't shrink and we compute the gap
 * ourselves.
 */
function useKeyboardInset() {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    const update = () => {
      const layoutH = window.innerHeight;
      const visualH = vv.height;
      const offsetTop = vv.offsetTop || 0;
      const inset = Math.max(0, Math.round(layoutH - visualH - offsetTop));
      root.style.setProperty('--kb-inset', `${inset}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--kb-inset');
    };
  }, []);
}

// React Query's online-mode resume only fires when its own focus/online
// listeners trigger; if the browser fires `online` while we're hydrating or
// the tab was backgrounded, paused mutations can sit forever. Force a resume
// on every `online` event so a queued set/RPE/confirm always reaches the
// server within a tick of reconnection.
function useAutoResumeMutations() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onOnline = () => resumeMutationsAndReconcileDrafts(qc);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [qc]);
}

/**
 * Remember each route's scroll offset and put it back on return.
 *
 * `main` used to hard-reset to top on every pathname change, so stepping into a
 * session editor and back dropped the coach at the top of a long athlete page —
 * "I lose the page". A route seen for the first time still starts at the top;
 * only a revisit restores.
 *
 * Restoring needs a retry: the target route is `React.lazy`, so at the moment
 * the effect runs the container is often still the Suspense fallback and has no
 * scrollable height yet. We re-apply across a few animation frames until the
 * content is tall enough, then stop.
 */
function useScrollRestoration(ref, pathname) {
  const positions = useRef(new Map());

  // Record continuously rather than on unmount: by the time an effect cleanup
  // runs, the new route may already have clamped scrollTop.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onScroll = () => positions.current.set(pathname, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, pathname]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const target = positions.current.get(pathname) ?? 0;
    if (target === 0) {
      el.scrollTo({ top: 0, left: 0 });
      return undefined;
    }

    let frame;
    let tries = 0;
    const apply = () => {
      if (!ref.current) return;
      ref.current.scrollTop = target;
      // Stop once it sticks, or after ~20 frames of the content not growing.
      if (Math.abs(ref.current.scrollTop - target) > 1 && tries < 20) {
        tries += 1;
        frame = requestAnimationFrame(apply);
      }
    };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [ref, pathname]);
}

export default function AppShell() {
  const mainRef = useRef(null);
  const { pathname } = useLocation();

  // Single global realtime channel for messages — every page sees fresh
  // threads + nav-tab badges without each having to subscribe individually.
  useMessagesRealtime();
  // Same pattern for notifications — feeds the bell badge live.
  useNotificationsRealtime();

  // Soft-keyboard tracking → `--kb-inset` CSS var (see hook docstring).
  useKeyboardInset();

  // Drain any offline mutation queue the moment connectivity returns.
  useAutoResumeMutations();

  useScrollRestoration(mainRef, pathname);

  return (
    <div className="flex flex-col md:flex-row h-full bg-gray-50">
      <SideNav />
      <main
        ref={mainRef}
        className="flex-1 overflow-y-auto"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <OfflineBanner />
        {/* `h-full` (not `min-h-full`) so flex-1 children with internal
            overflow scrollers — Messages thread / composer — get a hard
            height budget instead of letting the wrapper grow with their
            content. Pages whose content is naturally taller still scroll
            via main, since main has overflow-y-auto. */}
        <div className="mx-auto w-full max-w-5xl h-full flex flex-col">
          <Outlet />
        </div>
      </main>
      <BottomNav />
      <ToastHost />
    </div>
  );
}
