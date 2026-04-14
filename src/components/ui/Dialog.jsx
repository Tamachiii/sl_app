import { useEffect, useRef } from 'react';

export default function Dialog({ open, onClose, title, children }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-modal="true"
      aria-labelledby={title ? 'dialog-title' : undefined}
      className="backdrop:bg-black/40 rounded-2xl p-0 w-[calc(100%-2rem)] max-w-md shadow-xl"
    >
      <div className="p-5">
        {title && (
          <h2 id="dialog-title" className="text-lg font-semibold text-gray-900 mb-4">{title}</h2>
        )}
        {open && children}
      </div>
    </dialog>
  );
}
