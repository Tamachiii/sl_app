# CoachNote

Un bloc de texte libre signé : la consigne du coach sur un exercice, ou la note d'un athlète sur une série.

## Ce que fournit l'appelant

- Le titre qui dit qui parle, en 15 px gras : « Note du coach » en `blue`, « Note de Léa, série 2 » en `ink`.
- Le texte en `body`, tel qu'il a été écrit.
- Le bloc est un fond `surface`, rayon `radius-group`, padding `space-4`.

## À éviter

- Un liseré coloré sur le bord gauche : le titre suffit à dire qui parle.
- Tronquer la note. Elle est courte, elle s'affiche en entier.
