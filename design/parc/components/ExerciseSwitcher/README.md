# ExerciseSwitcher

La rangée de puces qui choisit l'exercice affiché sur l'écran de séance.

## Quand l'utiliser

- Sous le titre de la séance, pour passer d'un exercice à l'autre sans quitter l'écran. Un exercice terminé passe de lui-même au suivant.

## Ce que fournit l'appelant

- Une puce `pk-chip` par exercice, dans l'ordre de la séance, avec son nom court.
- `aria-current="true"` sur l'exercice affiché : il passe en `ink` sur fond, texte `surface`.
- Un défilement horizontal quand les puces dépassent la largeur.

## À éviter

- Des numéros devant les noms : l'ordre se lit déjà de gauche à droite.
- Plus de 6 exercices visibles : au-delà, la puce affichée défile au centre.
