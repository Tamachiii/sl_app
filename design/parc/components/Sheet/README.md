# Sheet

Une feuille qui monte du bas de l'écran, au-dessus d'un voile : elle remplace tous les dialogues centrés.

## Quand l'utiliser

- Choisir le RPE après une série validée (l'aperçu).
- Saisir la valeur réelle d'une série, remplacer ou sauter un exercice, confirmer une suppression.

## Ce que fournit l'appelant

- `pk-sheet` sur la feuille, `pk-sheet-handle` en tête, voile `overlay` derrière.
- Un titre en `title` (`h2`) relié par `aria-labelledby`, et un bouton de fermeture rond à droite (`pk-icon-btn` sur `fill`).
- Le contenu : une grille de choix (RPE en 5 colonnes, cases de 52 px, chiffres condensés), des champs (NumberField) ou deux boutons.
- Le choix fait passe en `blue` et `on-blue`, avec `aria-pressed="true"`. Choisir un RPE ferme la feuille.
- Le focus va dans la feuille à l'ouverture et revient sur le déclencheur à la fermeture.

## À éviter

- Une feuille plus haute que les deux tiers de l'écran : au-delà, c'est un écran.
- Une confirmation pour une action réversible : fais-la, puis propose « Annuler » dans un Toast.
