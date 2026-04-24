import Dialog from './Dialog';

export default function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmText = 'Delete', isDestructive = true }) {
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
          {confirmText}
        </button>
        <button
          onClick={onClose}
          className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200"
        >
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
