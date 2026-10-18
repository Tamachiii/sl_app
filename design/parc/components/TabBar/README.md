# TabBar

La barre d'onglets fixée en bas des écrans de premier niveau, sous 1024 px.

## Onglets

- Coach : Athlètes, Séances, Messages, Librairie.
- Athlète : Entraînement, Stats, Messages.
- À partir de 1024 px, les mêmes onglets passent dans une colonne à gauche.

## Ce que fournit l'appelant

- `pk-tabbar` sur le `<nav>`, `pk-tab` sur chaque lien, icône de 24 px au-dessus du libellé en `tab`.
- `aria-current="page"` sur l'onglet ouvert : il passe en `blue`. Les autres sont en `ink-2`.
- Un compte `pk-count` en haut à droite de l'icône (« 2 »), avec la phrase en `sr-only` (« 2 séances à revoir »). « 99+ » au-delà de 99.
- La TabBar disparaît sur les écrans de détail, où l'ActionBar prend la place.

## À éviter

- Plus de quatre onglets.
