// Package core-push-identity (review items P15, B37).
// Folded into en.js by the integrator; see ./README.md.
//
// The sentences of two error codes of lib/pushNotifications.js, shown under
// the notification toggles (StudentProfile, UserMenu). The codes that existed
// before are in `common.pushError`; `PUSH_ERROR_KEYS` of that file says which
// code reads which key, so the keys are named after the codes.
export default {
  pushIdentity: {
    offline:
      'No connection — notifications can’t be changed right now. Try again once this device is back online.',
    endpoint_refused:
      'The notification service of this browser isn’t supported, so notifications can’t be delivered to this device.',
  },
};
