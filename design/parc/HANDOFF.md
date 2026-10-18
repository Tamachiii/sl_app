# Passage au code de SL Coach Parc

Ce dossier contient tout ce qu'il faut pour reconstruire le front de sl_app dans le style Parc. Trois sources de vérité :

- `tokens.json` pour les valeurs,
- `README.md` pour les règles,
- les maquettes de `screens/` pour la mise en page, les textes et les états.

## Contenu

| Chemin | Rôle |
| --- | --- |
| `README.md` | Le guide de marque : principes, ton, couleur, typographie, espacement, gestes, mouvement. |
| `tokens.json` | Toutes les valeurs : couleurs, styles de texte, espacements, rayons, ombres. |
| `parc-tokens.css` | Les mêmes valeurs en variables CSS, celles que lit `bundle.css`. |
| `components/bundle.css` | Les classes `pk-*` des composants. |
| `components/<Nom>/` | Pour chaque composant, un README (usage et règles) et un aperçu HTML. |
| `screens/*.dc.html` | Les écrans du canevas. Ce sont des maquettes de référence, pas du code à copier. La structure, les textes et les états comptent, le format `.dc.html` non. |
| `icons/` | Les 21 icônes utilisées dans les écrans, en trait de 2 px dans une boîte de 24. Elles prennent `currentColor`, donc la couleur du texte autour (`ink-2` au repos, `blue` actif). |
| `fonts/` | Archivo variable (axes graisse et largeur) et sa licence OFL. |

## Décisions déjà prises

- **Thème clair uniquement.** La classe `dark` quitte `<html>` et `color-scheme` passe à `light`. La balise `theme-color` et le `theme_color` du manifeste prennent `#FFFFFF`. Le `background_color` du manifeste prend `#E3E6E4`.
- **Une seule famille, Archivo variable.** Le condensé passe par l'axe de largeur (`font-stretch: 62%`). Plus d'Inter, plus de JetBrains Mono, plus de Google Fonts.
- **Les dialogues deviennent des feuilles** qui montent du bas.
- **Une action réversible se fait tout de suite** et propose « Annuler » dans un toast. Une série ratée se marque par un appui long, jamais par un simple tap.
- **Textes** : tutoiement, casse de phrase. Pas de libellés en capitales, pas de points médians, pas d'émojis.
- **Accessibilité** : tout ce qui se touche fait au moins 44 px, et tout texte a un contraste d'au moins 4,5:1.
- **Pendant la migration**, les classes `pk-*` vivent à côté des anciennes classes `sl-*`. L'app a un aspect mixte sur la branche tant que tous les écrans ne sont pas migrés, c'est normal.

## Ordre de travail

1. **Fondation** : police, tokens, thème clair, `bundle.css`.
2. **Primitives** : un composant React par composant du design system.
3. **Écrans** : un écran par commit, dans l'ordre ci-dessous.
4. **Nettoyage** : on retire l'ancien thème.

| Ordre | Écran | Maquette |
| --- | --- | --- |
| 1 | Séance athlète | `screens/Seance.dc.html` |
| 2 | Entraînement athlète | `screens/Entrainement.dc.html` |
| 3 | Stats athlète | `screens/Stats.dc.html` |
| 4 | Athlètes, téléphone et grand écran | `screens/RosterTelephone.dc.html` et `screens/Roster.dc.html` |
| 5 | Séances coach | `screens/Seances.dc.html` |
| 6 | Revue de séance | `screens/Revue.dc.html` |
| 7 | Programme du bloc | `screens/Programme.dc.html` |
| 8 | Éditeur de séance | `screens/Editeur.dc.html` |
| 9 | Messages et conversation | `screens/MessagesCoach.dc.html` et `screens/Conversation.dc.html` |
| 10 | Librairie | `screens/Librairie.dc.html` |

`screens/RosterTelephone.dc.html` date d'avant le design system. Ses valeurs sont écrites en clair dans le fichier, mais elles sont identiques aux tokens.

## Prompts à coller dans Claude Code

### 1. Fondation

```
Lis design/parc/README.md, design/parc/tokens.json et design/parc/HANDOFF.md.
Sur une nouvelle branche redesign-parc, pose la fondation du thème Parc sans migrer d'écran :
1. Installe @fontsource-variable/archivo, importe sa feuille wdth.css dans le point d'entrée,
   et retire les liens Google Fonts de index.html.
2. Copie design/parc/parc-tokens.css et design/parc/components/bundle.css dans src/styles/,
   importe-les après Tailwind dans src/index.css, et fais pointer --font-sans sur Archivo.
3. Expose les tokens à Tailwind avec @theme inline (bg-ground, bg-surface, text-ink-2,
   rounded-group, etc.). L'ancienne échelle ink-950 à ink-700 reste en place jusqu'au nettoyage,
   les noms ne se chevauchent pas.
4. Passe en thème clair : classe dark, theme-color et color-scheme dans index.html,
   theme_color et background_color du manifeste dans vite.config.js, comme dit HANDOFF.md.
   Laisse les remaps .dark de src/index.css pour l'étape de nettoyage.
5. Lance npm run lint, npm test et npm run build, puis montre-moi le diff avant de committer.
```

### 2. Primitives

```
Crée les primitives React du design system Parc dans src/components/parc/,
une par dossier de design/parc/components/ (lis chaque README et chaque preview.html avant) :
Button, IconButton, ActionBar, LargeTitle, ExerciseSwitcher, SetPanel, SetRow, ListGroup et Row,
CoachNote, WeekDots, StatusText, SearchField, NumberField, Sheet, Toast et TabBar.
Ajoute SideNav pour le grand écran (screens/Roster.dc.html) et SegmentedControl
(le sélecteur à choix unique de screens/Librairie.dc.html).
Elles s'appuient sur les classes pk-* de bundle.css.
Sheet remplace Dialog et ConfirmDialog : focus piégé, Échap ferme, le focus revient au déclencheur.
Toast se branche sur ToastHost et accepte une action « Annuler ».
Écris un test par primitive. Ne migre encore aucun écran.
Lance lint et tests, puis montre-moi le diff.
```

### 3. Écrans

Premier écran :

```
Migre l'écran de séance athlète (SessionView) vers Parc en suivant design/parc/screens/Seance.dc.html :
même structure, mêmes états, mêmes textes.
Utilise uniquement les primitives de src/components/parc/.
Garde les données, les hooks et React Query tels quels, ne change que la présentation.
Le RPE se choisit dans une feuille après la validation d'une série, et une série se marque ratée
par un appui long, avec « Annuler » dans le toast.
Tous les textes passent par l'i18n : mets à jour fr, en et de.
Vérifie 44 px et 4,5:1, lance lint et tests, puis montre-moi le diff.
```

Pour les écrans suivants, reprends le même prompt dans l'ordre du tableau. Change le nom de l'écran et la maquette, et retire la phrase sur le RPE. Claude Code trouve lui-même le composant actuel de chaque écran.

### 4. Nettoyage

```
Tous les écrans sont migrés vers Parc. Dans src/index.css, retire les remaps .dark,
le @custom-variant dark, l'ancienne échelle de couleurs et les classes sl-*.
Supprime les composants remplacés (Dialog, ConfirmDialog, BottomNav, RestTimerBanner, RpeInput, etc.)
s'ils ne sont plus importés nulle part.
Remplace le contenu de docs/DESIGN_SYSTEM.md par un renvoi vers design/parc/.
Lance lint, tests et build, puis montre-moi le diff.
```

## Ligne à ajouter au CLAUDE.md du repo

```
- **`design/parc/`**: the Parc design system (light theme). Read `design/parc/README.md` before any UI change, take every value from `design/parc/tokens.json`, and follow the matching mock in `design/parc/screens/`.
```
