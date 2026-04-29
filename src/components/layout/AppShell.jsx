import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav';
import SideNav from './SideNav';
import { useMessagesRealtime } from '../../hooks/useMessages';

export default function AppShell() {
  const mainRef = useRef(null);
  const { pathname } = useLocation();

  // Single global realtime channel for messages — every page sees fresh
  // threads + nav-tab badges without each having to subscribe individually.
  useMessagesRealtime();

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
        <div className="mx-auto w-full max-w-5xl">
          <Outlet />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
