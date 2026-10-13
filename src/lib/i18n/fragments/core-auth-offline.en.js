// Package core-auth-offline (review items P8, L4, P5).
// Folded into en.js by the integrator; see ./README.md.
//
// `roleWait` is shown by the index route (routes.jsx) to a signed-in user
// whose role this device has not read yet, while it has no network to read it.
// The `signOut…` keys are the question components/auth/SignOutGuard.jsx asks
// before a sign-out that would discard writes the device has not sent.
export default {
  authOffline: {
    roleWait: 'Offline — your account will open as soon as this device is back online.',
    signOutTitle: 'Sign out and lose unsynced changes?',
    signOutOne:
      '{n} change made on this device has not been sent yet. It is sent as soon as the device has a connection again — if you sign out now, it is lost.',
    signOutMany:
      '{n} changes made on this device have not been sent yet. They are sent as soon as the device has a connection again — if you sign out now, they are lost.',
    signOutDraft:
      'Your program draft has changes that have not been sent yet. They are sent as soon as the device has a connection again — if you sign out now, they are lost.',
    signOutAnyway: 'Sign out anyway',
  },
};
