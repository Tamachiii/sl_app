# messaging-ux — docs to fold (wave 3, items B32, L30)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Messaging / notifications

Add after the bullet that starts "**Messaging composers are online-only, by explicit gate.**":

- **Enter sends a message only with a fine pointer, and never during an IME composition.** [MessageComposer.jsx](../src/components/messaging/MessageComposer.jsx) asks `window.matchMedia('(pointer: coarse)')` at the moment of the key (`touchScreen`): on a touch screen Enter is a newline and the Send button is the only way to send, because a soft keyboard has no Shift and a phone could otherwise not write a message of two lines; with a mouse Enter sends, and Shift, Ctrl or Meta with Enter is a newline. An Enter that confirms an IME conversion (`nativeEvent.isComposing`, or `keyCode` 229, which Safari gives once the composition is already over) sends nothing, on any device. `MessageComposer.test.jsx` stubs `window.matchMedia` for the touch case; the polyfill of `src/test/setup.js` answers `matches: false`, the mouse case.
- **A new message does not pull a reader out of the history.** [MessageThread.jsx](../src/components/messaging/MessageThread.jsx) records at each `scroll` of the log whether the reader is within `NEAR_BOTTOM_PX` (80px) of its end (`nearBottomRef`), and a new last message scrolls the thread to the bottom only then, or when the message is the reader's own. The flag starts true, so a thread opens at its bottom, and it is set back to true when `otherProfileId` changes, because `coach/CoachMessages` switches counterparts without remounting the thread. A bubble carries `wrap-anywhere` (`overflow-wrap: anywhere`), not `break-words`: `break-words` leaves a long URL as the bubble's smallest width, the shrink-to-fit columns around the bubble keep that width, and the thread scrolls sideways.

## docs/INVARIANTS.md — UserMenu / profile surface

Add after the bullet that starts "**`UserMenu` is role-aware.**":

- **The bell's popover hangs from the `UserMenu` group, not from the bell.** The group (`relative flex items-center gap-2 shrink-0`, in both modes) is the positioned box, and the wrapper of [NotificationBell.jsx](../src/components/notifications/NotificationBell.jsx) is not: the popover (`absolute right-0 top-12 w-[320px] max-w-[calc(100vw-2rem)]`) ends at the avatar's right edge, which is the page's right padding, and fits a screen of 320 to 390px. Anchored to the bell, an avatar further in, it began at `100vw - 384px`, off the left edge of a phone, in a `main` that does not scroll sideways. So a page that mounts `UserMenu` keeps it at its 16px right padding, and `NotificationBell` is mounted only inside `UserMenu`. The group takes no z-index: that would make it a stacking context, and the popovers' `z-30` (bell) and `z-20` (avatar menu) would count only inside it. The bell, the avatar and the bell's "Mark all read" (`sl-pill sl-pill-btn`) are 44px targets. Tests: `ui/UserMenu.popover.test.jsx` (the real bell inside the real menu, both modes), `notifications/NotificationBell.test.jsx`.

## docs/DESIGN_SYSTEM.md — Editorial page header

In item 1 of the list, replace "(`w-9 h-9 rounded-lg bg-ink-100 text-ink-700`)" with:

(`w-11 h-11 shrink-0 rounded-lg bg-ink-100 text-ink-700`, a 44px target that a long title cannot squeeze)

In item 3, replace "or a 9×9 spacer for balance." with:

or an 11×11 spacer for balance.

In the code sample, replace `className="w-9 h-9 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center"` with:

`className="w-11 h-11 shrink-0 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center"`

## docs/DESIGN_SYSTEM.md — Editorial page header

Add after the paragraph that starts "Every top-level page (both coach & student":

The notification popover of `ui/UserMenu` hangs from the right edge of the menu's group: the header that holds it keeps it at the page's right padding (`px-4` / `p-4` on a phone), or the 320px popover runs off the left edge of a 360px screen.

## CLAUDE.md — Feature → files map, row "Messaging (coach ↔ student)"

Replace "`messaging/MessageThread`, `messaging/MessageComposer`," with:

`messaging/MessageThread` (a new message scrolls the thread only for a reader within `NEAR_BOTTOM_PX` of its end, or for its sender; a bubble wraps a long URL with `wrap-anywhere`), `messaging/MessageComposer` (Enter sends with a mouse only — on `(pointer: coarse)` it is a newline — and never during an IME composition),

At the end of the row's test list, after "`lib/realtimeChannel.test.js`, on `test/fakeRealtime`", add:

; `messaging/MessageComposer.test.jsx`, `messaging/MessageThread.test.jsx` (the scroll on a log given a layout), `coach/CoachMessages.test.jsx`

## CLAUDE.md — Feature → files map, row "User menu popover"

Replace the row's file list with:

`ui/UserMenu` (every top-level page's right-aligned header action; its group is the `relative` box the bell's popover hangs from — the wrapper of `notifications/NotificationBell` is not positioned —, so the header keeps it at the page's right padding). Tests: `ui/UserMenu.popover.test.jsx`, `ui/UserMenu.pushToggle.test.jsx`
