import Dialog from './Dialog';
import { useI18n } from '../../hooks/useI18n';

export default function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmText, isDestructive = true }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="sl-mono text-[12px] text-ink-400 mb-5 leading-relaxed">{message}</p>
      <div className="flex gap-2">
        <button
          onClick={() => {
            onConfirm();
            onClose();
          }}
          className="flex-1 rounded-lg py-2.5 sl-display text-[13px] text-white"
          style={{
            background: isDestructive ? 'var(--color-danger)' : 'var(--color-accent)',
          }}
        >
          {confirmText || t('common.delete')}
        </button>
        <button
          onClick={onClose}
          className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200"
        >
          {t('common.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
