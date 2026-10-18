# Toast

Une ligne noire passagère au-dessus de l'ActionBar ou de la TabBar, qui confirme une action ou signale un échec.

## Ce que fournit l'appelant

- Le message en 15 px, qui reprend le verbe de l'action (« Série 4 sautée. », « Séance archivée. »).
- Au plus une action de retour, « Annuler », en bleu clair `#9DB8F5` sur `ink` (10,6:1).
- Pour une erreur : `role="alert"`, une croix rose `#FF9A8F` (10,3:1 sur `ink`) et une phrase qui dit comment réparer.
- Fond `ink`, texte `surface`, rayon `radius-control`, ombre `shadow-toast`.

## Comportement

- 6 secondes, 8 avec une action. Le temps s'arrête sous le doigt ou le focus.
- Trois toasts au plus à l'écran.

## À éviter

- Un toast qui valide quelque chose : l'action est déjà faite, le toast ne sert qu'à revenir en arrière.
