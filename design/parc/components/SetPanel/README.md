# SetPanel

Le panneau de la série en cours : répétitions et charge en chiffres géants condensés, et la référence de la dernière fois.

## Quand l'utiliser

- Une fois, en haut de l'écran de séance, sous le grand titre. C'est l'élément mémorable du système, rien d'autre n'a cette taille.

## Ce que fournit l'appelant

- Le nom de l'exercice en `title` et la position « Série 3 sur 4 » en `subhead`.
- Pour un exercice d'un superset : l'étiquette « Superset » (`small` gras, `blue` sur `blue-soft`) à la place du nom, qui reste le titre pour un lecteur d'écran, « Tour 1 sur 3 » à la place de la série, et sous cette ligne un SegmentedControl des exercices du superset, « C1 Pec Deck », « C2 Pompes », celui affiché enfoncé. La liste des séries se range alors en tours : « Tour 1 », puis la série de chaque exercice, nommée par son exercice, son code dans l'indicateur. Le bouton principal dit « Valider C1 ».
- Les deux chiffres en `numeral-hero` (`pk-numeral-hero`), avec leur unité dessous en `subhead` : « répétitions » et « kg de lest ». Pour un maintien, « secondes » à la place des répétitions. Au poids du corps, la seconde colonne affiche « PDC » et « poids du corps ».
- La ligne « Il y a n jours, sets × reps à charge » sous un filet `line`, quand une performance passée existe.

## À éviter

- Un troisième chiffre géant. Le RPE et le repos ont leur place ailleurs.
- Des chiffres qui ne tiennent pas : au-delà de trois caractères, passe à `numeral-lg`.
