import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../../hooks/useI18n';

export default function Dialog({ open, onClose, title, children }) {
  const ref = useRef(null);
  // One id per Dialog. Every mounted Dialog renders its <h2>, open or not, so
  // a fixed id would be in the document once per dialog and `aria-labelledby`
  // would resolve to the first of them: the title of another dialog.
  const titleId = useId();
  const { t } = useI18n();

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
      aria-labelledby={title ? titleId : undefined}
      // bg-white + text-gray-900 both have dark-mode remaps in index.css (bg-white
      // flips to ink-850, text-gray-900 flips to ink-0), so the dialog follows the
      // in-app theme instead of the browser's prefers-color-scheme — which is
      // what the native <dialog> UA styles otherwise track.
      className="backdrop:bg-black/40 rounded-2xl p-0 w-[calc(100%-2rem)] max-w-md shadow-xl fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 m-0 bg-white text-gray-900"
    >
      <div className="p-5 relative">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label={t('common.close')}
          className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-gray-900 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {title && (
          <h2 id={titleId} className="text-lg font-semibold text-gray-900 mb-4 pr-8">{title}</h2>
        )}
        {open && children}
      </div>
    </dialog>
  );
}
