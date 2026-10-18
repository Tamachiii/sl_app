# ActionBar

La barre fixée en bas d'un écran d'athlète, qui porte l'action principale à portée de pouce, et le repos en cours.

## Quand l'utiliser

- Sur l'écran de séance : repos à gauche, « +30 s », puis « Valider la série n ».
- Quand toutes les séries sont faites : « Confirmer la séance » seul, sur toute la largeur.
- Sur une séance de plusieurs exercices, une ligne au-dessus de celle de l'action principale : l'exercice d'avant à gauche, « ‹ Dips », et celui d'après à droite, « Pec Deck › », en boutons texte `ink` de 44 px, et entre eux un point par exercice (ExerciseSteps). Rien du côté où la séance s'arrête. La ligne du bas ne change pas.
- Sur un éditeur du coach, pour « Enregistrer » ou « Envoyer le retour ».

## Ce que fournit l'appelant

- Le bouton principal (Button primaire en `pk-btn-lg`, `flex: 1`).
- Le compte à rebours en `numeral-md` `blue`, sous l'étiquette « Repos » en `small`, quand un repos tourne.
- Un padding bas au moins égal à la zone sûre (`safe-bottom`).
- Le contenu de la page doit s'arrêter au-dessus de la barre (padding bas égal à sa hauteur).

## À éviter

- Plus de trois éléments sur la ligne de l'action principale.
- Le compte à rebours dans une région live : on annonce le début et la fin du repos, pas chaque seconde.
