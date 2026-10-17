import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';

// `container`: where the lightbox is drawn — the document's <body> by default,
// or the open sheet (a modal <dialog>) it was opened from: the page behind a
// modal dialog is inert and under it, and so would a lightbox drawn there be.
export default function VideoLightbox({ open, onClose, container, children }) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Escape closes the player and nothing else: heard first — in the capture
    // phase of the window — and kept here, so that a sheet the player was
    // opened from (which closes on Escape too) stays open behind it.
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] bg-black flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close')}
        className="absolute top-4 right-4 w-11 h-11 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 text-white active:scale-95 transition ring-1 ring-white/30"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <div
        className="max-w-4xl w-full max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    container ?? document.body
  );
}
