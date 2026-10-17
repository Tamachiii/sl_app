import { useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useSendMessage } from '../../hooks/useMessages';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { Icon } from '../parc';

const MAX_LEN = 4000;

// Read at the moment of the key, not held in state: a tablet that gains a
// mouse changes its answer, and a test can stub `window.matchMedia`.
function touchScreen() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export default function MessageComposer({ recipientProfileId, recipientName, autoFocus = false }) {
  const { t } = useI18n();
  const name = (recipientName || '').trim();
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const sendMessage = useSendMessage();
  const textareaRef = useRef(null);

  // Messaging is online-only: useSendMessage is not in the offline mutation
  // registry, so an offline send would pause on "Sending…" forever and be
  // silently dropped by a reload (no registered mutationFn to resume). Gate
  // the send instead of letting it hang; the draft stays in the box.
  // (SessionFeedbackComposer applies the same gate on the coach side.)
  const isOnline = useOnlineStatus();

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LEN;
  const canSend =
    !!recipientProfileId && trimmed.length > 0 && !tooLong && !sendMessage.isPending && isOnline;

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
        onError: (err) => setError(err?.message || t('parcMessages.sendError')),
      },
    );
  }

  function handleKeyDown(e) {
    // Enter sends, Shift+Enter / Ctrl+Enter inserts a newline — with a mouse
    // and a keyboard. A soft keyboard has no Shift: on a touch screen Enter is
    // a newline and only the button sends. An Enter that confirms an IME
    // conversion (keyCode 229 in Safari, which has already ended the
    // composition) belongs to the IME and sends nothing.
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229 || touchScreen()) return;
    e.preventDefault();
    handleSubmit(e);
  }

  // The bar at the bottom of the conversation: the field, rounded, and the
  // round send button (design/parc/screens/Conversation.dc.html).
  return (
    <div className="border-t border-line-strong bg-surface">
      {(error || tooLong) && (
        <p role="alert" className="m-0 px-4 pt-2 text-[13px] leading-[1.35] text-red md:px-8">
          {error || t('parcMessages.tooLong', { n: MAX_LEN })}
        </p>
      )}
      {!isOnline && (
        <p role="status" className="pk-small m-0 px-4 pt-2 md:px-8">
          {t('parcMessages.offline')}
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex items-end gap-2 px-4 py-3 md:px-8">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus={autoFocus}
          disabled={!recipientProfileId}
          placeholder={name ? t('parcMessages.placeholder', { name }) : t('parcMessages.placeholderAnyone')}
          aria-label={name ? t('parcMessages.composerLabel', { name }) : t('parcMessages.placeholderAnyone')}
          className="pk-field block flex-1 resize-none rounded-[22px] px-4 py-2.5 leading-[1.4] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={sendMessage.isPending ? t('parcMessages.sending') : t('parcMessages.send')}
          className="pk-btn pk-btn-primary h-11 w-11 shrink-0 rounded-full p-0"
        >
          <Icon name="send" size={20} />
        </button>
      </form>
    </div>
  );
}
