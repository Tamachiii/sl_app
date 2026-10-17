# NumberField

Le champ d'un nombre tapé (charge, répétitions, secondes), habillage du composant `DecimalInput` de l'app.

## Ce que fournit l'appelant

- Un `<label>` visible en `small` au-dessus du champ, qui donne l'unité (« Charge en kg »).
- Le champ `pk-field`, en `inputmode="decimal"` ou `"numeric"`. Dans une feuille de saisie, la valeur passe en chiffres condensés de 28 px et le champ en 56 px de haut.
- La logique de `DecimalInput` reste la même : virgule ou point acceptés, texte gardé tel quel, `parseDecimalInput` à l'enregistrement.
- Une saisie refusée : `aria-invalid="true"` (contour `red` de 2 px) et un message en `red` sous le champ, relié par `aria-describedby`, qui dit la plage attendue.

## À éviter

- `type="number"`.
- Un texte de champ sous 16 px.
