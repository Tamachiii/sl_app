# Button

Les boutons du système : un principal par écran, des secondaires neutres, des liens d'action et un destructif.

## Variantes

- `pk-btn pk-btn-primary pk-btn-lg` : l'action qui fait avancer, 56 px, `blue` et `on-blue`, rayon `radius-button`. Un seul par écran, dans l'ActionBar le plus souvent.
- `pk-btn pk-btn-secondary` : action neutre sur `surface`, fond `fill`, texte `ink`.
- `pk-btn pk-btn-on-ground` : action neutre posée directement sur `ground`, fond `surface`.
- `pk-btn pk-btn-text` : lien d'action en `blue`, sans fond (« Ajouter une série »).
- `pk-btn pk-btn-danger` : suppression confirmée, `red` et `on-blue` (6,6:1).

## Ce que fournit l'appelant

- Un libellé en casse de phrase qui dit l'action, avec son objet quand il aide (« Valider la série 3 »).
- `disabled` quand l'action n'est pas possible, l'opacité passe à 45 %.
- Pour un bouton à icône seule, `pk-icon-btn` et un `aria-label`.

## À éviter

- Deux boutons principaux côte à côte.
- Une flèche ajoutée au libellé, ou un libellé en capitales.
