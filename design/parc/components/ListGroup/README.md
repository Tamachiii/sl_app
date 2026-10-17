# ListGroup

Une liste groupée blanche sur le fond `ground`, sous un titre de section : la façon par défaut de ranger du contenu.

## Quand l'utiliser

- Athlètes d'un roster, séances d'un bloc, exercices suivants, réglages, historique.
- Les sections ordonnent par priorité (« À suivre » avant « À jour ») : le titre de section porte une information, jamais une étiquette décorative.

## Ce que fournit l'appelant

- Le titre de section en `headline` (`h2`), à `space-2.5` au-dessus de la liste.
- `pk-group` sur la liste, `pk-row` sur chaque ligne. Une ligne cliquable est un `<a>` ou un `<button>` qui porte `pk-row`.
- Dans la ligne : le titre en `headline`, la seconde ligne en `caption`, et à droite un chevron, un statut (StatusText) ou une valeur.

## À éviter

- Une carte par élément avec ombre et bordure.
- Une ligne de moins de `row-min` de haut.
