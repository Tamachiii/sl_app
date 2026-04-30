import { useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useSendMessage } from '../../hooks/useMessages';

const MAX_LEN = 4000;

export default function MessageComposer({ recipientProfileId, autoFocus = false }) {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const sendMessage = useSendMessage();
  const textareaRef = useRef(null);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LEN;
  const canSend = !!recipientProfileId && trimmed.length > 0 && !tooLong && !sendMessage.isPending;

  function autoSize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function handleChange(e) {
    setBody(e.target.value);
    setError(null);
    autoSize();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSend) return;
    sendMessage.mutate(
      { recipientProfileId, body: trimmed },
      {
        onSuccess: () => {
          setBody('');
          setError(null);
          requestAnimationFrame(autoSize);
        },
        onError: (err) => setError(err?.message || t('messaging.sendError')),
      },
    );
  }

  function handleKeyDown(e) {
    // Enter sends, Shift+Enter / Ctrl+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="bg-white border-t border-ink-100">
      {(error || tooLong) && (
        <div role="alert" className="sl-mono text-[11px] text-danger px-4 md:px-8 pt-1.5">
          {error || t('messaging.tooLong', { n: MAX_LEN })}
        </div>
      )}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 px-4 md:px-8 py-2.5"
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus={autoFocus}
          disabled={!recipientProfileId}
          placeholder={t('messaging.placeholder')}
          aria-label={t('messaging.composerLabel')}
          className="flex-1 resize-none rounded-2xl bg-ink-100 px-3 py-2 text-[16px] text-gray-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={t('messaging.send')}
          className="sl-btn-primary text-[12px] disabled:opacity-50 shrink-0"
          style={{ padding: '10px 14px' }}
        >
          {sendMessage.isPending ? t('messaging.sending') : t('messaging.send')}
        </button>
      </form>
    </div>
  );
}
