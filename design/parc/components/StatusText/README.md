# StatusText

Le statut qui demande l'attention du coach, écrit en fin de ligne : un mot, une couleur, jamais une pastille seule.

## Statuts

- « n à revoir » en `blue` : des séances confirmées attendent la revue du coach.
- « Silencieux n j » en `amber` : aucune séance depuis n jours.
- « Sans programme » en `red` : aucun bloc actif.

## Ce que fournit l'appelant

- Le texte en 14 px gras, aligné à droite de la ligne (ListGroup), sur `surface`.
- Un seul statut par athlète, le plus urgent. Les autres se lisent sur sa fiche.

## À éviter

- Une pastille colorée sans texte.
- Mettre le statut en capitales.
