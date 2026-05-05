// Eager-load the LoginPage chunk before the user actually signs out, so the
// post-signOut redirect doesn't hit a blank Suspense fallback while the chunk
// streams in. Cheap to call repeatedly — Vite/browser cache the module after
// the first hit.
export function preloadLogin() {
  return import('../components/auth/LoginPage');
}
