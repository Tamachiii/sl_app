import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FIELD_LEFT_MS, createFieldWatch, isField } from './fieldWatch';

const el = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild;
};

/** `html` in the page; returns its first element. */
function inPage(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild;
}

/** What a keystroke does: the value changes, the field says so. */
function type(field, value, eventType = 'input') {
  field.value = value;
  field.dispatchEvent(new Event(eventType, { bubbles: true }));
}

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

let watch;
let heard;
let unsubscribe;

beforeEach(() => {
  vi.useFakeTimers();
  watch = createFieldWatch();
  heard = vi.fn();
  unsubscribe = watch.subscribe(heard);
});

afterEach(() => {
  unsubscribe();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('isField', () => {
  it.each([
    ['<input>'],
    ['<input type="text">'],
    ['<input type="number">'],
    ['<input type="search">'],
    ['<input type="password">'],
    ['<input type="date">'],
    ['<textarea></textarea>'],
    ['<select><option>a</option></select>'],
  ])('%s holds what someone is entering', (html) => {
    expect(isField(el(html))).toBe(true);
  });

  it.each([
    ['<button>Save</button>'],
    ['<a href="#/x">link</a>'],
    ['<input type="checkbox">'],
    ['<input type="radio">'],
    ['<input type="submit">'],
    ['<input type="BUTTON">'],
    ['<input type="range">'],
    ['<div tabindex="0"></div>'],
  ])('%s does not', (html) => {
    expect(isField(el(html))).toBe(false);
  });

  it('an editable region does, and nothing at all does not', () => {
    expect(isField({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isField(null)).toBe(false);
    expect(isField(document.body)).toBe(false);
  });
});

describe('a field in use', () => {
  it('is one that has the focus', () => {
    const field = inPage('<textarea></textarea>');
    expect(watch.inUse()).toBe(false);
    expect(watch.hasFocus()).toBe(false);

    field.focus();
    expect(watch.hasFocus()).toBe(true);
    expect(watch.inUse()).toBe(true);
    expect(heard).toHaveBeenCalled();
  });

  it('stays in use for a moment after the focus left it: the tap that took the focus is not over', async () => {
    const field = inPage('<input>');
    const button = inPage('<button>Create</button>');
    field.focus();
    heard.mockClear();

    // The press of a tap on the button: the focus moves, the click is still to come.
    button.focus();
    await flush();
    expect(watch.hasFocus()).toBe(false);
    expect(watch.inUse()).toBe(true);
    expect(heard).toHaveBeenCalled(); // …and whoever reads `inUse` is told at once

    vi.advanceTimersByTime(FIELD_LEFT_MS - 1);
    expect(watch.inUse()).toBe(true);

    heard.mockClear();
    vi.advanceTimersByTime(1);
    expect(watch.inUse()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1); // the end of the moment is told too
  });

  it('counts from the last field that was left', () => {
    const first = inPage('<input>');
    const second = inPage('<input>');
    first.focus();
    second.focus();
    vi.advanceTimersByTime(FIELD_LEFT_MS - 100);
    second.blur();

    vi.advanceTimersByTime(FIELD_LEFT_MS - 1);
    expect(watch.inUse()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(watch.inUse()).toBe(false);
  });

  it('is not what leaving a button or a checkbox makes', () => {
    const button = inPage('<button>Save</button>');
    const box = inPage('<input type="checkbox">');
    button.focus();
    box.focus();
    box.blur();
    expect(watch.inUse()).toBe(false);
  });
});

describe('text that was typed and is still there', () => {
  it('counts without the focus', () => {
    const field = inPage('<textarea></textarea>');
    const button = inPage('<button>Elsewhere</button>');
    expect(watch.holdsTypedText()).toBe(false);

    field.focus();
    type(field, 'Bien joué sur les tractions');
    button.focus();
    vi.advanceTimersByTime(FIELD_LEFT_MS);

    expect(watch.inUse()).toBe(false);
    expect(watch.holdsTypedText()).toBe(true);
  });

  it('no longer counts once the field is emptied (the message was sent)', () => {
    const field = inPage('<textarea></textarea>');
    type(field, 'ok');
    expect(watch.holdsTypedText()).toBe(true);

    field.value = ''; // what a component does after sending: no event comes with it
    expect(watch.holdsTypedText()).toBe(false);

    type(field, 'and another');
    expect(watch.holdsTypedText()).toBe(true);
  });

  it('no longer counts once the field is gone from the page (the form closed)', () => {
    const field = inPage('<input type="text">');
    type(field, 'Pull-up');
    expect(watch.holdsTypedText()).toBe(true);

    field.remove();
    expect(watch.holdsTypedText()).toBe(false);
  });

  it('is not the text a field was given: only what someone typed into it', () => {
    inPage('<input type="text" value="Marie">');
    inPage('<textarea>a note that was saved last week</textarea>');
    expect(watch.holdsTypedText()).toBe(false);
  });

  it('is not blank text, and not a choice in a list', () => {
    const field = inPage('<textarea></textarea>');
    const list = inPage('<select><option value="a">a</option><option value="b">b</option></select>');
    type(field, '  \n ');
    type(list, 'b', 'change');
    expect(watch.holdsTypedText()).toBe(false);
  });

  it('counts a value that arrives as a `change` (a date picked, a field filled by the browser)', () => {
    const field = inPage('<input type="date">');
    type(field, '2026-10-14', 'change');
    expect(watch.holdsTypedText()).toBe(true);
  });

  it('counts a number, a password, an editable region', () => {
    const number = inPage('<input type="number">');
    type(number, '82.5');
    expect(watch.holdsTypedText()).toBe(true);
    number.remove();

    const password = inPage('<input type="password">');
    type(password, 'correct horse');
    expect(watch.holdsTypedText()).toBe(true);
    password.remove();

    const region = inPage('<div></div>');
    Object.defineProperty(region, 'isContentEditable', { value: true }); // jsdom does not compute it
    region.textContent = 'draft';
    region.dispatchEvent(new Event('input', { bubbles: true }));
    expect(watch.holdsTypedText()).toBe(true);
  });

  it('hears a keystroke that a handler stops on its way up', () => {
    const field = inPage('<input type="text">');
    field.parentElement.addEventListener('input', (event) => event.stopPropagation());
    type(field, 'typed');
    expect(watch.holdsTypedText()).toBe(true);
  });
});

describe('listening', () => {
  it('stops with the last subscriber, and starts from nothing with the next', () => {
    const field = inPage('<textarea></textarea>');
    const other = watch.subscribe(() => {});
    field.focus();
    type(field, 'draft');
    field.blur();

    unsubscribe();
    expect(watch.holdsTypedText()).toBe(true); // one subscriber is left
    expect(watch.inUse()).toBe(true);

    other();
    expect(watch.inUse()).toBe(false);
    expect(watch.holdsTypedText()).toBe(false);

    // Nobody listens: a keystroke is not heard.
    heard.mockClear();
    type(field, 'more');
    field.focus();
    expect(watch.holdsTypedText()).toBe(false);
    expect(heard).not.toHaveBeenCalled();

    unsubscribe = watch.subscribe(heard);
    type(field, 'again');
    expect(watch.holdsTypedText()).toBe(true);
  });

  it('is nothing at all without a document', () => {
    const nowhere = createFieldWatch(null);
    const off = nowhere.subscribe(() => {});
    expect(nowhere.hasFocus()).toBe(false);
    expect(nowhere.inUse()).toBe(false);
    expect(nowhere.holdsTypedText()).toBe(false);
    off();
  });
});
