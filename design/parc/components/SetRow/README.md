# SetRow

La ligne d'une série dans la liste de l'exercice affiché : un indicateur rond, la cible, et le RPE ou l'état.

## États

- **Faite** : indicateur `pk-set-dot-done` (rond `blue`, coche `on-blue`), titre « Série n, faite », RPE à droite en `body-strong`.
- **Ratée** : ligne sur `red-soft`, indicateur `pk-set-dot-failed` avec une croix, titre en `red`, ce qui a été fait en seconde ligne (« 3 répétitions sur 5 »).
- **En cours** : indicateur `pk-set-dot-current` (anneau `ink` de 2 px et numéro), « En cours » en `blue` à droite.
- **À venir** : indicateur `pk-set-dot-pending` (fond `fill`, numéro en `ink-2`).
- **Hors plan** : ligne sur `amber-soft`, seconde ligne en `amber` qui commence par « Hors plan ».

## Ce que fournit l'appelant

- La cible en `caption` : « 5 répétitions, 20 kg », « 10 secondes, poids du corps ».
- Un `aria-label` sur la ligne quand l'indicateur est seul porteur d'information.
- Les gestes : un tap ouvre la feuille de la série (valeur réelle, RPE), un appui long de 500 ms la marque ratée. La validation passe par l'ActionBar.

## À éviter

- Une opacité réduite sur les séries faites : le texte doit garder son contraste.
- Marquer une série ratée sur un simple tap.
