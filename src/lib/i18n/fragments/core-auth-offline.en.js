// Package core-auth-offline (review items P8, L4, P5).
// Folded into en.js by the integrator; see ./README.md.
//
// `roleWait` is shown by the index route (routes.jsx) to a signed-in user
// whose role this device has not read yet, while it has no network to read it.
export default {
  authOffline: {
    roleWait: 'Offline — your account will open as soon as this device is back online.',
  },
};
