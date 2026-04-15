import Dialog from './Dialog';

export default function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmText = 'Delete', isDestructive = true }) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-sm text-gray-600 mb-6">{message}</p>
      <div className="flex gap-3">
        <button
          onClick={() => {
            onConfirm();
            onClose();
          }}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold text-white ${
            isDestructive ? 'bg-danger hover:bg-red-600' : 'bg-primary hover:bg-blue-700'
          }`}
        >
          {confirmText}
        </button>
        <button
          onClick={onClose}
          className="flex-1 bg-gray-100 text-gray-700 rounded-lg py-2.5 text-sm font-semibold hover:bg-gray-200"
        >
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
