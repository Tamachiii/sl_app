// What the page can tell, from the outside, about the fields someone is using.
// It answers for components/ui/UpdatePrompt, which must neither reload over
// what is being entered nor draw its card on top of it:
//
//   • `hasFocus()` — a field has the focus.
//   • `inUse()` — a field has the focus, or lost it less than FIELD_LEFT_MS
//     ago. The second half is about the TAP that took the focus away, which is
//     not over when the focus moves (see FIELD_LEFT_MS).
//   • `holdsTypedText()` — a field that was typed into still holds that text.
//     A message, a feedback or a form that is written and not sent lives in
//     the state of a component and nowhere else: it is in progress whether its
//     field has the focus or not.
//
// The watch listens to the document while someone is subscribed, and only then.

const NOT_TYPED_INTO = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden',
]);

/** A control that holds what someone is typing or choosing. */
export function isField(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    return !NOT_TYPED_INTO.has((el.getAttribute('type') || 'text').toLowerCase());
  }
  return el.isContentEditable === true;
}

/**
 * How long a field counts as in use after it lost the focus.
 *
 * A tap on a button moves the focus at the PRESS and is a click only at the
 * release. Whatever is drawn between the two under the finger takes the
 * release: the click then belongs to neither element and the tap is lost — a
 * form's "Create" that sends nothing. On a phone the keyboard is also on its
 * way out for about this long, and everything pinned to the bottom of the
 * window moves with it.
 */
export const FIELD_LEFT_MS = 400;

// A <select> always has a value: it is a choice, not text.
const holdsText = (el) => isField(el) && el.tagName !== 'SELECT';

function textOf(el) {
  if (typeof el.value === 'string') return el.value;
  return el.textContent || '';
}

/**
 * One watch over `doc`. The app uses the single instance at the end of this
 * file; the argument exists for the tests.
 */
export function createFieldWatch(doc = typeof document !== 'undefined' ? document : null) {
  const listeners = new Set();
  const typedInto = new Set();
  let justLeft = false;
  let leftTimer = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const hasFocus = () => Boolean(doc) && isField(doc.activeElement);

  const onFocusIn = () => notify();

  const onFocusOut = (event) => {
    if (isField(event.target)) {
      justLeft = true;
      clearTimeout(leftTimer);
      leftTimer = setTimeout(() => {
        justLeft = false;
        notify();
      }, FIELD_LEFT_MS);
    }
    // Browsers have moved the focus by the time `focusout` is heard; asking
    // once more after the event costs nothing where one has not.
    notify();
    queueMicrotask(notify);
  };

  const onTyped = (event) => {
    if (holdsText(event.target)) typedInto.add(event.target);
  };

  // In the capture phase: a handler that stops an event on its way up (React's
  // `stopPropagation` stops the native one too) does not hide it from here.
  const EVENTS = [
    ['focusin', onFocusIn],
    ['focusout', onFocusOut],
    ['input', onTyped],
    ['change', onTyped],
  ];

  function listen() {
    if (!doc) return;
    for (const [type, handler] of EVENTS) doc.addEventListener(type, handler, true);
  }

  function unlisten() {
    if (doc) {
      for (const [type, handler] of EVENTS) doc.removeEventListener(type, handler, true);
    }
    clearTimeout(leftTimer);
    justLeft = false;
    typedInto.clear();
  }

  return {
    /** `listener()` runs when `inUse()` may have changed. Returns the function that unsubscribes. */
    subscribe(listener) {
      if (listeners.size === 0) listen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) unlisten();
      };
    },
    // `document.activeElement` stays on the field while the window itself is in
    // the background, which is what is wanted: a message half typed in a tab
    // the coach left for a minute is still being typed.
    hasFocus,
    inUse: () => hasFocus() || justLeft,
    /**
     * True while a field that was typed into is still in the page with text in
     * it. It cannot tell text that was sent from text that was not: a field
     * that saves when it is left and keeps showing what was typed counts too,
     * until its page is left. That errs on the side of asking — the update is
     * offered where it could have been applied — never on the side of a reload
     * over a draft. A field that is emptied (a message that was sent) or
     * removed (a form that closed, another page) no longer counts.
     */
    holdsTypedText() {
      for (const el of typedInto) {
        if (!el.isConnected) typedInto.delete(el);
        else if (textOf(el).trim() !== '') return true;
      }
      return false;
    },
  };
}

/** The app's watch over its own document; it listens while UpdatePrompt is mounted. */
export const fieldWatch = createFieldWatch();
