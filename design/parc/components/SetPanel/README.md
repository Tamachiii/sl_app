# SetPanel

Le panneau de la série en cours : répétitions et charge en chiffres géants condensés, et la référence de la dernière fois.

## Quand l'utiliser

- Une fois, en haut de l'écran de séance, sous le sélecteur d'exercice. C'est l'élément mémorable du système, rien d'autre n'a cette taille.

## Ce que fournit l'appelant

- Le nom de l'exercice en `title` et la position « Série 3 sur 4 » en `subhead`.
- Les deux chiffres en `numeral-hero` (`pk-numeral-hero`), avec leur unité dessous en `subhead` : « répétitions » et « kg de lest ». Pour un maintien, « secondes » à la place des répétitions. Au poids du corps, la seconde colonne affiche « PDC » et « poids du corps ».
- La ligne « Il y a n jours, sets × reps à charge » sous un filet `line`, quand une performance passée existe.

## À éviter

- Un troisième chiffre géant. Le RPE et le repos ont leur place ailleurs.
- Des chiffres qui ne tiennent pas : au-delà de trois caractères, passe à `numeral-lg`.
