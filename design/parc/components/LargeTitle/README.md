# LargeTitle

L'en-tête d'un écran : un grand titre condensé, une ligne de contexte, et les boutons ronds de navigation.

## Deux formes

- **Écran de premier niveau** (Athlètes, Séances, Entraînement, Stats) : le titre à gauche, le menu du compte à droite sur la même ligne.
- **Écran de détail** (séance, éditeur, revue) : une ligne de boutons ronds (retour à gauche, options à droite), puis le titre dessous.

## Ce que fournit l'appelant

- Le titre en `large-title` (`pk-large-title`), un par écran, en `h1`.
- Une ligne de contexte en `subhead` : des faits séparés par des virgules, jamais une étiquette en capitales au-dessus du titre.
- Les boutons ronds en `pk-icon-btn`, avec un `aria-label`. Le retour passe par `useBackOr(fallback)`.

## À éviter

- Un titre centré. Le titre se lit en haut à gauche, comme une app native.
- Plus de deux boutons dans la ligne de navigation.
