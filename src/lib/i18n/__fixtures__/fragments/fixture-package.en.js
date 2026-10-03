// TEST FIXTURE — a complete fragment, as a package would ship it. Never
// loaded by the app: index.js globs ./fragments, not this folder.
export default {
  fixturePackage: {
    title: 'Check-in',
    greeting: 'Hello {name}',
    pain: {
      yes: 'It hurt',
      no: 'No pain',
    },
  },
};
