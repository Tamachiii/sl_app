import { useEffect, useRef, useState } from 'react';

/**
 * Click-to-edit text component.
 * Renders as a button (showing `value` or `placeholder`), becomes an input when clicked.
 * Commits on Enter or blur. Cancels on Escape.
 */
export default function EditableText({
  value,
  onSave,
  placeholder = 'Untitled',
  className = '',
  inputClassName = '',
  ariaLabel,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    if (next !== (value ?? '')) {
      onSave(next);
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(value ?? '');
    setEditing(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel || 'Edit title'}
        // The box has to occupy the SAME footprint as the button it replaces,
        // or clicking a title makes the page twitch. An <input> defaults to
        // roughly 20 characters wide and ignores its container, which overflowed
        // every caller: 45px past its slot on a phase divider, 61px in the
        // session editor, sliding the orange box under the meta and the ⋯ menu.
        // The calc + `-mx-1` reproduce the button's own `px-1 -mx-1` bleed
        // exactly, so the text stays put instead of jumping ~9px right.
        //
        // `text-[16px]` is NOT a style choice — iOS Safari zooms the whole page
        // when a focused input is under 16px, and the app is a PWA people use
        // one-handed mid-set. `leading-tight` keeps that 16px from growing the
        // row it sits in.
        className={`w-[calc(100%+0.5rem)] -mx-1 min-w-0 rounded border border-primary bg-ink-850 px-1 py-0.5 text-[16px] leading-tight text-ink-0 focus:outline-none ${inputClassName}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      aria-label={ariaLabel || `Edit ${value || placeholder}`}
      // `hover:bg-ink-100`, NOT `hover:bg-gray-100`: index.css remaps the bare
      // `.bg-gray-100` for dark mode but has no rule for the hover VARIANT, so
      // that class kept Tailwind's raw #f3f4f6 and painted a near-white plate
      // under the pointer — the title's contrast fell to 2.32:1 (from 7.01:1)
      // and a bright heading vanished outright. The ink hover variants are
      // remapped, so this one darkens the way every other hover in the app does.
      className={`text-left hover:bg-ink-100 rounded px-1 -mx-1 transition-colors ${className}`}
    >
      {value || <span className="text-gray-400 italic">{placeholder}</span>}
    </button>
  );
}
