import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav';
import SideNav from './SideNav';
import { useMessagesRealtime } from '../../hooks/useMessages';
import { useNotificationsRealtime } from '../../hooks/useNotifications';

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

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pathname]);

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
        <div className="mx-auto w-full max-w-5xl min-h-full flex flex-col">
          <Outlet />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
