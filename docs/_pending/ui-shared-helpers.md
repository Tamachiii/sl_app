# ui-shared-helpers — docs to fold (wave 2, items: none)

Each block: target doc, section, then the text to fold in.

## docs/DESIGN_SYSTEM.md — The `sl-*` primitives

Replace, in the subsection "`sl-pill` — chips, tags, small action buttons", the second example (the one commented "action button in a page header") with:

```jsx
// ✅ Do — a pill that is a button: 44px, see "44px targets" below
<button className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200">Edit</button>

// ❌ A bare pill as a button is 23px high
<button className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200">Edit</button>
```

Add after the subsection "`sl-pill` — chips, tags, small action buttons":

````markdown
### 44px targets — `sl-pill-btn` and `sl-hit`

Anything pressed is 44px in both directions at least: the app is used one-handed between two sets. Two classes carry that size, for the two kinds of control.

**`sl-pill-btn`** — a pill that is a button grows. Beside `sl-pill`: `min-height` and `min-width` 44px, the label centred, `padding-inline: 14px`. The label stays the pill's 10px.

```jsx
// ✅ 56×44 for a short label
<button className="sl-pill sl-pill-btn bg-ink-100 text-accent hover:bg-ink-200">Undo</button>

// ✅ a one-character pill: the utility wins over the class's padding → 44×44
<button className="sl-pill sl-pill-btn bg-ink-100 text-ink-500 px-2" aria-label="Remove">✕</button>
```

**`sl-hit`** — a control that must stay as small as it is drawn (a 16px close icon, a ⋯ in a dense row) keeps its box and gets a larger area to press: a pseudo-element centred on it, 44px at least and never smaller than the control. Nothing around it moves.

```jsx
// ✅ the icon stays 16×16; a press up to 22px from its centre is a press on it
<button className="sl-hit shrink-0 text-ink-400 hover:text-gray-900" aria-label={t('common.dismiss')}>
  <svg className="w-4 h-4" …/>
</button>
```

Three things to know about `sl-hit`:

- **It uses `::after`.** Do not combine it with `after:` utilities on the same element (the stretched link of a roster card, `after:absolute after:inset-0`, is one).
- **An ancestor with `overflow: hidden` cuts the area** where it passes the ancestor's edge.
- **Two `sl-hit` controls nearer than 44px overlap**, and the later one in the document takes the press where they meet. Leave 14px between a 16px `sl-hit` icon and the next control (`gap-4`), as `ui/ToastHost` does.

Both classes stand in `@layer components` and neither is `!important`: a utility beside them (`px-2`, `w-full`, `min-w-0`) wins. `src/test/hitTargets.test.js` holds the two classes to 44px in the stylesheet — jsdom has no layout, so a component test can only check that the class is on the control.

Used by `ui/ToastHost` (the action pill and the dismiss icon).
````

## docs/DESIGN_SYSTEM.md — Tokens

Add to the bullet that starts "**Contrast is tested**" (the snippet of `ui-dialog-contrast` adds it), after its last sentence:

`mixOver(top, alpha, bottom)` gives what a tint is on the surface behind it — `bg-push/15` on a card is `#3a2117` — for a test that asks whether a colour can be read on its own tint.

## docs/DESIGN_SYSTEM.md — new section "Typed numbers — `DecimalInput`", after "iOS 16px input rule"

Add:

````markdown
## Typed numbers — `DecimalInput`

A number a person types — a weight, reps, seconds — is [`DecimalInput`](../src/components/ui/DecimalInput.jsx), never `<input type="number">`. A number field reads "82,5" by the language of the **browser**: 825 in a Chromium whose UI is English, `""` in WebKit, which a caller then stores as null. `DecimalInput` is a text field (`type="text"`, `inputMode="decimal"`, a `pattern`, 16px) that keeps the text as typed, comma or point, and [`parseDecimalInput`](../src/lib/number.js) is the one reader of it.

```jsx
// The caller holds the TEXT, as with any controlled input…
const [weight, setWeight] = useState(decimalText(log.target_weight_kg));

<DecimalInput
  value={weight}
  onChange={(e) => setWeight(e.target.value)}
  aria-label={t('coach.slot.setWeightAria', { n })}
  className={inputCls}
/>

// …and reads the number when it commits.
const parsed = parseDecimalInput(weight);
if (!parsed.ok) return setError(t('uiSharedHelpers.decimalInvalid')); // never write on garbage
save(parsed.value); // null only for an empty field
```

- **Props**: `value` (the text; a number is shown as its text), `onChange(event, parsed)` — the native event, then `parseDecimalInput` of the new text under the field's rules — and the rules: `min`, `max` (inclusive), `allowEmpty` (default `true`), `integer` (whole numbers, with the numeric keypad). `invalid` marks the field from outside. Everything else reaches the `<input>`: `aria-label`, `id`, `placeholder`, `disabled`, `onBlur`, `autoFocus`, `ref`, `className`.
- **Hold the text, not the number.** A caller that stores `parsed.value` loses the separator while it is typed ("82," is 82). `decimalText(stored)` gives the text a field starts with; it is for seeding state, not for the text being typed.
- **The field draws no message.** Text that is not a number of the caller's range sets `aria-invalid="true"` and a `title` (`uiSharedHelpers.decimalInvalid`, or `uiSharedHelpers.integerInvalid`). Its callers sit in table cells and one-line rows and say what went wrong where they have room.
- **An empty field that needs an answer** (`allowEmpty={false}`) is not marked until the caller passes `invalid`.
- **Inside a `<form>`** the `pattern` makes the browser refuse the submit with its own message. A form that shows its own alert is `noValidate`.
- **`className` replaces the default look** (the app's bordered mono field); `text-[16px]` is added to it either way.

What `parseDecimalInput` accepts: one optional separator, comma or point, with digits on at least one side — "82", "82,5", "82.5", ",5", "82," — and spaces around it. It refuses "abc", "82kg", "1e3", "1,000.5", "8 2" and "-5" (`reason: 'format'`), a number outside `min`/`max` (`'range'`), and an empty field when `allowEmpty` is `false` (`'empty'`). It never repairs.

Not yet on it — still `type="number"`: `student/SetRow` (actual reps and weight), `coach/ExerciseSlotRow` (reps, seconds, weight, rest), `student/BodyweightCard`, `student/StudentProgramAuthor` (`NumberField`), `student/MyGoals`, `coach/StudentGoalsSection`, `coach/ExerciseLibrary`.
````

## docs/DESIGN_SYSTEM.md — new section "Toasts", after "Typed numbers — `DecimalInput`"

Add:

````markdown
## Toasts

[`pushToast`](../src/lib/toast.js) shows a transient line at the bottom of the screen; [`ui/ToastHost`](../src/components/ui/ToastHost.jsx), mounted once in `AppShell`, draws the stack.

```js
pushToast('errors.generic');                       // an error (the default kind): role="alert"
pushToast(t('…'), { kind: 'info' });               // anything else: role="status"

pushToast(t('…'), {                                // one action
  kind: 'info',
  action: { label: 'uiSharedHelpers.undo', onClick: () => restore(set) },
});
```

- **`message` and `action.label` are an i18n key or a finished sentence.** The host resolves a key; there are no parameters, so a sentence with a value in it is translated by the caller.
- **One action per toast.** The host calls `onClick` once — a second tap before the toast is gone calls nothing — then closes the toast, also when the action throws. A toast that runs out or is dismissed calls nothing: the action is a way back, never the thing that commits.
- **A toast stops its clock while it is under the pointer or holds the focus**, and starts again with what was left, two seconds at least. It stays 6 s, 8 s with an action.
- **Plain toasts merge on (kind, message); toasts with an action never do** — two "Set removed" undo two different sets. The store keeps the three newest on screen.
- **Look**: the action is `sl-pill sl-pill-btn bg-ink-100 text-accent hover:bg-ink-200` — accent on the pill's surface is 5.46:1, 4.97:1 hovered; `ui/ToastHost.test.jsx` recomputes both. The dismiss icon is `sl-hit`.
````

## docs/DESIGN_SYSTEM.md — new section "Exercise type badge — `TypeBadge`", after "Tinted surfaces — the `color-mix` recipe"

Add:

````markdown
## Exercise type badge — `TypeBadge`

The pill that says what type an exercise is comes from [`TypeBadge`](../src/components/ui/TypeBadge.jsx), and its colour and name from the list in [`lib/exerciseTypes.js`](../src/lib/exerciseTypes.js).

```jsx
// ✅ Do
<TypeBadge type={ex.type} />
<TypeBadge type={ex.type} className="shrink-0" />

// ❌ Every type that is not pull is drawn as a push, under the raw value of the column
<span className={`sl-pill ${ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'}`}>{ex.type}</span>
```

- A listed type is drawn in its own tint and named in the language of the app (`coach.library.typePull`, `coach.library.typePush`).
- A type the list does not have is a neutral pill (`bg-ink-100 text-ink-500`) under its own id. No type draws nothing.
- `EXERCISE_TYPES` is also the source of a type `<select>` — `exerciseTypeLabel(type.id, t)` for the option's text — and of a chart's colour (`type.color`, a `var(--color-…)`).

**Adding a type**: an entry in `EXERCISE_TYPES` with its classes written out in full (`'bg-legs/15 text-legs'` — Tailwind finds classes by reading the file as text), and its token `--color-legs` in the `@theme` of `src/index.css`. `src/lib/exerciseTypes.test.js` then holds the entry to four things: an id the `exercise_type` enum of `supabase/schema.sql` has, a name in the three languages, a token that `.dark` does not remap, and 4.5:1 for that colour on its own 15% tint over a card, a dialog row and the page (push: 4.78:1 on a card; pull: 7.42:1).

Not yet on it — still the hand-written ternary: `coach/SessionReview`, `coach/ExerciseLibrary`, `student/SlotDeviationBar`, `student/StudentProgramAuthor`.
````

## docs/DESIGN_SYSTEM.md — Responsive layout

Add after the paragraph that starts "Content inside `main` is wrapped":

**Sticky inside `main` is `top: 0`.** `main` is the one box that scrolls, and it pads its top by `env(safe-area-inset-top)`. A sticky box is held inside the *content* box of its scroller, so `top: 0` is the inner edge of that padding: just below the notch, where the element already sits before any scroll. `top: 'env(safe-area-inset-top)'` adds the inset a second time and drops the element onto the page's header. [`ui/OfflineBanner`](../src/components/ui/OfflineBanner.jsx) is the one sticky element of `main`: `zIndex: 40`, over the popovers of a page (`z-10` to `z-30`) and under the toasts (`z-50`).

## docs/DESIGN_SYSTEM.md — Quick reference

Replace the row "status chip or compact action" with:

| status chip, tag, filter pill | `sl-pill` |
| a pill that is a button | `sl-pill sl-pill-btn` (44px) |
| a small icon button | `sl-hit` on the button (44px area, same box) |

Add after the row "compact CTA inside a form/card":

| a number a person types | `<DecimalInput>` + `parseDecimalInput` (never `type="number"`) |
| an exercise's type | `<TypeBadge type={ex.type} />` |
| a line that confirms, with a way back | `pushToast(message, { kind: 'info', action: { label, onClick } })` |
| a date, a number, a day name, a plural | `lib/i18n/format.js`, with `lang` from `useI18n` |
| a page's back button | `useBackOr(fallback)` |

## docs/INVARIANTS.md — Shell, routing, viewport

Add after the bullet that starts "**iOS Safari auto-zooms focused**":

- **A number a person types is `DecimalInput`, read by `parseDecimalInput` — never `<input type="number">`, never `Number()` or `parseFloat()` on the text of a field.** A number field decides what "82,5" means by the language of the browser: 825 in a Chromium whose UI is English, `""` in WebKit, and `""` was stored as null over a logged weight. [`lib/number.js`](../src/lib/number.js) reads a comma or a point as the one separator and refuses everything else (`{ ok: false, reason }`); its `value` is null for an empty field and for nothing else, so a write guarded by `ok` cannot put null, or another number, in place of what was typed. `Number('82,5')` is `NaN` and `parseFloat('82,5')` is 82. The caller holds the text and parses when it commits; `decimalText` seeds the field and is never applied to the text being typed (rewriting "82.0" to "82" under the cursor makes the next key give 825). Tests: `lib/number.test.js`, `ui/DecimalInput.test.jsx`.
- **Anything pressed is 44px: a pill that is a button takes `sl-pill-btn`, a control that must stay small takes `sl-hit`.** Both are in `@layer components` of `src/index.css` and held to 44px by `src/test/hitTargets.test.js`. `sl-hit` draws its area with `::after`: it cannot share an element with an `after:` utility, an ancestor's `overflow: hidden` cuts it, and two of them nearer than 44px overlap.
- **A sticky element of `main` uses `top: 0`, not the safe-area inset.** A sticky box is held inside the content box of its scroller, and `main` already pads its top by `env(safe-area-inset-top)`: 0 is below the notch, the inset would be counted twice. `ui/OfflineBanner` relies on it; `ui/OfflineBanner.sticky.test.jsx` fails when `main` stops being the scroller that carries the inset, or when an element is put between `main` and the banner.
- **A page's back button calls `useBackOr(fallback)`, never `navigate(-1)` on its own.** `navigate(-1)` is `history.back()`: on the first entry of the tab — a push notification, a pasted link, the installed app started on a deep link — it leaves the app in a browser and does nothing in an installed PWA. [`hooks/useBackOr`](../src/hooks/useBackOr.js) goes one step back when the app has a page behind, and otherwise to `fallback` with `replace`. It reads `history.state.idx`, the number the router gives its entries, not `location.key`: a redirect on arrival (`<Navigate replace>`, the return from login) keeps idx 0 under a new key. A test of a screen that asserts `navigate(-1)` under a single-entry `MemoryRouter` is asserting the fallback branch. The coach's deep views keep their explicit destinations (ARCHITECTURE, "Back-button routing in coach deep views"). Still on `navigate(-1)`: `student/SessionView`, `student/MyGoals`, `student/StudentProfile`.

## docs/INVARIANTS.md — new section "Language of what is printed", after "React / hooks discipline"

Add:

````markdown
## Language of what is printed

- **A date, a time, a number, a day name and a plural are printed through [`lib/i18n/format.js`](../src/lib/i18n/format.js), with `lang` from `useI18n`.** The app has its own language switch; `toLocaleDateString()` with no locale, and `Intl.*` built with `undefined`, print in the language of the device. `LOCALES` is the one table from a language to a locale — `format.test.js` holds its keys to `LANGUAGES` — so no file builds its own (`const LOCALE = { en: 'en-US', … }`, `lang === 'fr' ? 'fr-FR' : …`).
- **A bare calendar date is formatted from the string, not from `new Date(string)`.** `scheduled_date` and `performed_on` are `YYYY-MM-DD`; `new Date('2026-10-13')` is midnight UTC, the 12th for everyone west of Greenwich. `toDate` — used by every formatter of the module — reads a bare date as that day where the device is, and a timestamp as the instant it says. The formatters return `''` for a missing or invalid value, where `Intl.DateTimeFormat.format` throws.
- **No formatter is kept between calls.** An `Intl.DateTimeFormat` keeps the time zone the device had when it was built. `format.test.js` switches the zone of the process mid-run and fails on a cached one. The day-name tables are the exception: they are built from a week in UTC and printed in UTC.
- **A plural is `pluralKey(lang, n, …)`, never `n === 1`.** French counts 0 and 1.5 as singular ("0 séance"); the rule belongs to the language. `pluralKey(lang, n, 'student.training.sessions')` picks `…sessionsOne` or `…sessionsMany` — the pair the dictionaries carry — from `Intl.PluralRules`; every category but `one` takes the plural form. A pair that is not named that way is passed as `{ one, other }`.
- **Day names come from `dayNames(lang, width)` — Monday first, index `day_number - 1`.** `'narrow'`, `'short'` and `'long'` replace `DAY_LABELS`, `DAY_FULL` and `DAY_FULL_LONG` of `lib/day.js`, which are English. The short form drops the full stop of a French abbreviation ("lun", where Intl says "lun."); `dayName(lang, n, width)` is `''` for a value that is not 1 to 7.
- **An exercise's type is drawn by `ui/TypeBadge` from `lib/exerciseTypes.js`.** A ternary on `'pull'` draws every other type as a push. The list is not the database's enum and may be behind it: a type it does not have is drawn neutral under its own id. It may never be ahead — `lib/exerciseTypes.test.js` fails on an id that `exercise_type` in `supabase/schema.sql` lacks.
- **These keys are not seen by `lib/i18n/usage.test.js`**, which reads literal `t('a.b')` calls: a key built by `pluralKey`, a `labelKey` of `EXERCISE_TYPES`, a toast's `message` or `action.label`. `lib/exerciseTypes.test.js` checks its own; a counted string and a toast are checked by the test of the screen that prints them.

Not yet through `format.js`: the locale tables of `student/StudentTraining`, `student/WeeklyVolumePanel`, `student/ExerciseProgressChart`, `hooks/useMessages`, `hooks/useNotifications` and `messaging/SessionReferenceCard`; the device-locale dates and numbers of `coach/SessionsFeed`, `coach/CoachHome`, `coach/SessionReview`, `student/SessionView`, `student/MyGoals`, `student/BodyweightCard`, `student/SessionCalendar` and `student/StudentProfile`; the `n === 1` plurals of `coach/ProgramSwitcher`, `coach/ProgramTrashDialog`, `coach/AdoptSwapDialog`, `coach/RemoveExerciseDialog`, `coach/StudentGoalsSection`, `student/MyGoals`, `student/StudentTraining`, `student/PersonalRecords` and `ui/OfflineBanner`; the day tables in `student/SessionView`, `student/StudentTraining`, `coach/SessionRow` and `coach/StudentWeekStrip`.
````

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**No mutation failure is silent**":

- **A toast with an action is never merged with another, and its action is a way back, not a commit.** `pushToast` de-dupes on (kind, message) so that a burst of the same failure is one line — but only among toasts without an `action`: two "Set removed" toasts carry two different callbacks, and merging them gives the second set the undo of the first. The host calls `action.onClick` at most once and only on the button; a toast that runs out, is dismissed or is pushed off the screen (the store keeps the three newest) calls nothing, so the write the toast announces must already be made. `pushToast`'s signature and the exports of [`lib/toast.js`](../src/lib/toast.js) (`pushToast`, `dismissToast`, `getToasts`, `subscribeToasts`) are what other modules and their mocks rely on. Tests: `lib/toast.test.js`, `ui/ToastHost.test.jsx`.

## docs/ARCHITECTURE.md — i18n: dictionaries and fragments

Add after the paragraph that starts "The integrator folds the fragments":

**Formatting.** `src/lib/i18n/format.js` is what prints a value in the app's language: `LOCALES` / `localeOf` (language → Intl locale), `toDate`, `formatDate`, `formatTime`, `formatDateTime`, `formatDateRange`, `formatRelativeDays`, `formatNumber`, `dayNames` / `dayName` and `pluralCategory` / `pluralKey`. Every function takes `lang` as its first argument and is pure; the module imports neither React nor `index.js` (which runs under Vite only), so a plain Node script can use it. It holds no dictionary: `pluralKey` returns a key, and `t` resolves it.

## docs/ARCHITECTURE.md — Back-button routing in coach deep views

Add after the list that ends with "Still an explicit destination, never `navigate(-1)`.":

A page with no single logical parent uses `useBackOr(fallback)` (`src/hooks/useBackOr.js`): `navigate(-1)` when `history.state.idx` is above 0 — the app has a page behind this one — and `navigate(fallback, { replace: true })` on the first entry of the tab. Under a router that does not write to `window.history` (`MemoryRouter`) the first entry is the one whose `location.key` is `'default'`.

## CLAUDE.md — Repo map

Replace the line "lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js" with:

```
  lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js
                 number.js (parseDecimalInput — the one reader of a typed number; decimalText)
                 toast.js (pushToast — the toast store; a toast can carry one action)
                 exerciseTypes.js (EXERCISE_TYPES — the types of an exercise, their names and colours)
```

Replace the line "i18n/ (en · fr · de dictionaries, index.js, mergeFragments.js," with:

```
                 i18n/ (en · fr · de dictionaries, index.js, mergeFragments.js,
                 format.js — dates, numbers, day names and plurals in the app's language,
```

Replace the line "rest-timer-push (Web Push bridge) · push-subscription (toggle)" with:

```
                 rest-timer-push (Web Push bridge) · push-subscription (toggle)
                 back-or (useBackOr — a back button that has somewhere to go on a deep link)
```

Replace the line "ui/          EditableText  LanguageSelect  UserMenu  Dialog" with:

```
    ui/          EditableText  LanguageSelect  UserMenu  Dialog
                 DecimalInput (the field of a typed number)  TypeBadge  ToastHost  OfflineBanner
```

In the line that starts "static guards:", add `hitTargets` at the end of the list, before "(.test.js)" — after `contrast`, which the snippet of `ui-dialog-contrast` adds.

## CLAUDE.md — Feature → files map, row "Mutation error toast"

Replace the row with:

| Toasts (mutation errors; a line with one action, e.g. Undo) | `lib/toast.js` (`pushToast(message, { kind, action: { label, onClick } })` — plain toasts merge on kind + message, toasts with an action never; three on screen at most), `ui/ToastHost` (in `AppShell`; calls an action once, stops a toast's clock under the pointer or the focus), `lib/mutationErrors.js`, `queryClient.js` (MutationCache onError), fragment key `uiSharedHelpers.undo`; tests `lib/toast.test.js`, `ui/ToastHost.test.jsx` |

## CLAUDE.md — Feature → files map, row "i18n (EN/FR/DE)"

Add at the end of the row's cell:

Formatting in the app's language — dates, times, numbers, Monday-first day names, plurals: `lib/i18n/format.js` (`LOCALES`, `formatDate`, `formatDateTime`, `formatNumber`, `dayNames`, `pluralKey`, …), pure, `lang` first; `lib/i18n/format.test.js` runs it in three time zones

## CLAUDE.md — Feature → files map, row "Offline support (student writes)"

Add at the end of the row's cell:

The banner is sticky at the top of `main` (`top: 0` — `main` carries the safe-area inset): `ui/OfflineBanner.sticky.test.jsx`

## CLAUDE.md — Feature → files map

Add after the row "Day-number helpers":

| Typed numbers (weights, reps: comma or point, never null for garbage) | `lib/number.js` (`parseDecimalInput` → `{ ok, value }` or `{ ok: false, reason }`; `decimalText`; `decimalPattern`), `ui/DecimalInput` (text field with the decimal keypad; the caller holds the text), fragment keys `uiSharedHelpers.decimalInvalid` / `integerInvalid`; tests `lib/number.test.js`, `ui/DecimalInput.test.jsx` |
| Exercise types and their badge | `lib/exerciseTypes.js` (`EXERCISE_TYPES`, `exerciseType`, `exerciseTypeLabel`), `ui/TypeBadge`, the tokens `--color-pull` / `--color-push` in `index.css`; `lib/exerciseTypes.test.js` holds each type to the database's enum, a name in three languages and AA on its tint |
| Back button on a deep-linked page | `hooks/useBackOr` (`useBackOr(fallback)` — one step back, or the fallback with `replace` on the first entry of the tab), `hooks/useBackOr.test.jsx` (both routers) |
| 44px touch targets | `index.css` (`.sl-pill-btn` — a pill that is a button; `.sl-hit` — a small control with a 44px area), `test/hitTargets.test.js` |

## CLAUDE.md — When you add a feature

Add to the end of step 3, as a new sub-bullet:

   - A field for a number is `ui/DecimalInput`, and its text is read by `parseDecimalInput` — no `type="number"`, no `Number()` on a field. A button is 44px: `sl-pill sl-pill-btn`, or `sl-hit` on a small icon. A date, a number, a day name or a counted string goes through `lib/i18n/format.js` with the app's `lang` — no `toLocale…()` without a locale, no `n === 1`. An exercise's type is `ui/TypeBadge`; a page's back button is `useBackOr(fallback)`. Run `npx vitest run src/lib/number.test.js src/lib/i18n src/lib/exerciseTypes.test.js src/test/hitTargets.test.js src/components/ui src/hooks/useBackOr.test.jsx --maxWorkers=2`.
