SL Coach Parc est le design de l'application de coaching de street lifting. Il est clair, pensé pour rester lisible au soleil d'un parc de street workout, et pour une main posée entre deux séries. Un coach y programme des blocs, ses athlètes les exécutent série par série.

## Principes

- **Le chiffre d'abord.** Sur l'écran de séance, la série en cours se lit à bout de bras : répétitions et charge en `numeral-hero`, condensé. Tout le reste est plus petit et plus calme.
- **Le pouce en bas.** L'action principale vit dans la barre d'action (ActionBar), en bas de l'écran. Rien d'important ne se trouve en haut d'un écran d'athlète.
- **Un exercice à la fois.** La séance montre un exercice, pas une pile de cartes. Son nom ne s'écrit qu'une fois, dans le SetPanel. Au-dessus de l'action principale, l'ActionBar nomme l'exercice d'avant et celui d'après, et un point par exercice entre eux dit où on en est (ExerciseSteps). Un superset compte pour une étape : son panneau dit « Superset » et le tour, passe d'un exercice à l'autre (C1, C2 : la lettre de l'étape, la place dans le superset), et ses séries se lisent en tours.
- **Des listes, pas des cartes.** Le contenu se range en listes groupées blanches (ListGroup) sur le fond `ground`. Un seul panneau par écran (SetPanel).
- **Une seule couleur.** `blue` désigne ce qui avance : l'action principale, l'onglet actif, la série validée. Il ne décore jamais.

## Contenu et ton

- L'interface tutoie l'athlète et le coach, comme l'application actuelle (« Ton coach », « Maintiens appuyé »).
- Les boutons disent ce qu'ils font, en casse de phrase : « Valider la série 3 », « Ajouter une série », « Envoyer le retour ». Le toast reprend le même verbe : « Série 3 validée ».
- Les libellés restent en casse de phrase. Pas de capitales d'affichage, pas de petites étiquettes en majuscules au-dessus des titres.
- Une information secondaire se sépare par une virgule : « Lundi, 3 exercices », « Séance 7 sur 24, Force tirage ».
- Les nombres suivent la langue de l'application : « 17,5 kg » et « RPE 7,5 » en français, « 17.5 kg » en anglais. Une durée de repos s'écrit « 1:30 ».
- Un écran vide invite à agir : « Aucun programme. Crée le premier bloc d'Inès. »
- Une erreur dit ce qui s'est passé et comment réparer : « Non enregistré. Vérifie ta connexion et réessaie. »
- Pas d'emoji.

## Couleur

- **Fond et surfaces.** `ground` pour la page. `surface` pour les listes, le panneau de série, les barres et les feuilles. `fill` pour un contrôle neutre posé sur `surface`.
- **Texte.** `ink` pour les titres et les chiffres, `ink-2` pour le secondaire. `ink-3` seulement sur `surface`, jamais sur `ground`.
- **Marque.** `blue` (bleu acier) sur `surface` ou `ground`, texte `on-blue` sur `blue`. Pressé : `blue-pressed`.
- **États.** `blue` pour fait, `red` pour raté ou destructif, `amber` pour silencieux ou hors plan. Chaque état porte aussi une icône ou un mot. Les fonds `red-soft` et `amber-soft` marquent une ligne entière.
- **Graphiques.** `chart-pull` et `chart-push`, toujours sur `surface`, toujours avec une légende écrite.
- **Champs.** Contour `line-control` d'1 px, 2 px en `red` quand la saisie est refusée.

## Typographie

- Une seule famille, Archivo, en un fichier variable : graisse de 100 à 900, largeur de 62 à 125.
- **Condensé (largeur 62) pour les grands chiffres et les grands titres :** `numeral-hero`, `large-title`, `numeral-lg`, `numeral-md`. Applique `pk-condensed`.
- **Largeur normale pour tout le reste :** `title`, `headline`, `body`, `subhead`, `caption`, `small`, `tab`.
- Chiffres tabulaires (`pk-tnum`) pour tout ce qui change ou s'aligne : compte à rebours, charges, totaux.
- Champs de saisie en 16 px au minimum, sinon Safari iOS zoome.

## Espacement et mise en page

- Marges de page `space-4` sur téléphone, `space-8` à partir de 768 px. Contenu limité à `content-max`.
- Écran d'athlète : grand titre, SetPanel, puis listes. ActionBar fixée en bas, avec les exercices voisins au-dessus de l'action principale.
- Écran de coach : grand titre, recherche, listes groupées par priorité (« À suivre », « À jour »). TabBar fixée en bas.
- Entre deux blocs d'un écran, `space-4`. Entre un titre de section et sa liste, `space-2.5`. Entre deux groupes, `space-6`.
- À partir de 1024 px, la barre d'onglets devient une colonne à gauche et les listes passent sur deux colonnes (voir Roster large du canevas).

## Forme et profondeur

- Rayons selon la hiérarchie : `radius-panel` pour le panneau de série et les feuilles, `radius-group` pour les listes, `radius-button` pour le bouton principal, `radius-control` pour les autres contrôles, `radius-full` pour ce qui est rond.
- Pas de bordure autour des listes, pas d'ombre sur la page. Seules la feuille (`shadow-sheet`) et le toast (`shadow-toast`) flottent.
- Un filet `line` sépare deux lignes d'une liste.

## Interaction et gestes

- Tout ce qui se touche fait au moins `target-min`. Le bouton principal fait `button-lg-height`.
- Les dialogues deviennent des feuilles qui montent du bas (Sheet) : choix du RPE, valeur réelle, remplacement d'exercice, confirmation.
- Valider une série : le bouton de l'ActionBar. Marquer une série ratée : appui long sur sa ligne, jamais un simple tap.
- Une action réversible se fait tout de suite et propose « Annuler » dans un Toast.
- Focus clavier : contour `blue` de 2 px décalé de 2 px.

## Mouvement

- Une feuille monte en 240 ms, ease-out. La coche d'une série validée apparaît en 160 ms.
- Rien ne bouge sans action de la personne, sauf le compte à rebours. Respecte `prefers-reduced-motion`.

## Iconographie

- Icônes en trait de 2 px dans une boîte de 24, tracées en SVG en ligne avec `stroke="currentColor"`. 24 px dans la barre d'onglets, 22 px dans les boutons ronds, 16 à 18 px dans une ligne.
- Le groupe Icons contient le jeu complet. L'encre des fichiers est `ink-2`.

## Logo

- La marque est l'haltère de l'icône d'application, groupe Logos. Elle reste en orange tant qu'elle n'est pas redessinée : à refaire en `blue` et `ink` pour suivre ce design.

## Migration depuis SL Coach

- Les classes `pk-*` de `bundle.css` peuvent vivre à côté des anciennes classes `sl-*` pendant la migration, écran par écran.
- Le thème passe en clair : `theme_color` du manifeste et `<meta name="theme-color">` prennent la valeur de `surface`, `color-scheme` passe à `light`, et la classe `dark` quitte `<html>`.
- Les polices viennent du fichier Archivo de ce système, plus de Google Fonts ni d'Inter ni de JetBrains Mono.
