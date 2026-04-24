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
        className={`rounded border border-primary bg-white px-2 py-0.5 text-[16px] focus:outline-none focus:ring-2 focus:ring-primary ${inputClassName}`}
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
      className={`text-left hover:bg-gray-100 rounded px-1 -mx-1 transition-colors ${className}`}
    >
      {value || <span className="text-gray-400 italic">{placeholder}</span>}
    </button>
  );
}
