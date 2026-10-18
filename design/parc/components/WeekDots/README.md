# WeekDots

La semaine d'un athlète en sept points, du lundi au dimanche, sous son nom dans le roster.

## États d'un point

- Fait : rond plein `blue` (`is-done`).
- Aujourd'hui avec une séance prévue : anneau `ink` de 2 px (`is-today`).
- Prochaine séance conseillée : anneau `ink-3` (`is-next`).
- Repos ou rien : rond plein `line-strong`.

Les états se distinguent par la forme (plein ou anneau) et pas seulement par la couleur.

## Ce que fournit l'appelant

- Les sept états, calculés par `buildDayStrip`.
- Un `aria-label` qui résume la semaine en phrase (« lundi et mercredi faits, séance prévue aujourd'hui ») sur le conteneur, en `role="img"`.

## À éviter

- Un état « manqué » : un jour prévu qui passe n'est pas un échec. Le statut « Silencieux » le dit mieux.
