// Package coach-decimal-inputs (review item L9).
// Folded into en.js by the integrator; see ./README.md.
export default {
  coachDecimalInputs: {
    // Under the volume weight of an exercise of the library, when Create or
    // Save is refused. "0" is a number, so the shared "Enter a number" would
    // be wrong about it: the range is the reason.
    volumeWeightRange: 'Enter a number from 0.1 to 99.99',
    // Under the weight of a new goal, when Save is refused.
    goalWeightRange: 'Enter a weight from 0 to 9999.99 kg',
  },
};
