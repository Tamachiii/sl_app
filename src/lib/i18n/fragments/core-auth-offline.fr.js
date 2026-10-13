// Package core-auth-offline (review items P8, L4, P5).
// Folded into fr.js by the integrator; see ./README.md.
export default {
  authOffline: {
    roleWait: 'Hors ligne — ton compte s’ouvrira dès que cet appareil aura retrouvé le réseau.',
    signOutTitle: 'Te déconnecter et perdre ce qui n’est pas synchronisé ?',
    signOutOne:
      '{n} changement fait sur cet appareil n’a pas encore été envoyé. Il partira dès que l’appareil aura retrouvé une connexion — si tu te déconnectes maintenant, il est perdu.',
    signOutMany:
      '{n} changements faits sur cet appareil n’ont pas encore été envoyés. Ils partiront dès que l’appareil aura retrouvé une connexion — si tu te déconnectes maintenant, ils sont perdus.',
    signOutDraft:
      'Le brouillon de ton programme contient des modifications qui n’ont pas encore été envoyées. Elles partiront dès que l’appareil aura retrouvé une connexion — si tu te déconnectes maintenant, elles sont perdues.',
    signOutAnyway: 'Me déconnecter quand même',
  },
};
