-- ============================================================
-- Web Push for ordinary chat messages.
--
-- Session feedback, session confirmations, and slot deviations already
-- fan out a Web Push, but a plain coach↔student chat message produced
-- NOTHING when the app was closed — only the realtime badge, which
-- requires an open tab. Time-sensitive coaching messages could sit
-- unseen for days.
--
-- This trigger mirrors the proven notify_student_on_session_feedback
-- pattern (2026_05_12_feedback_push.sql): best-effort net.http_post to
-- the send-push Edge Function, secrets from Vault, wrapped in EXCEPTION
-- so push failure can never roll back the message INSERT. Differences:
--
--   * fires only for ordinary chat (session_id IS NULL) — feedback rows
--     keep their dedicated trigger;
--   * inserts NO notifications row — the Messages tab unread badge is
--     the in-app surface for chat, and a bell entry would double-count;
--   * tag 'chat-<sender_id>' collapses multiple messages from the same
--     sender into one lock-screen entry (the SW re-notifies on update);
--   * direction-agnostic: the recipient may be the coach or the student
--     (the deep-link picks the right surface from the recipient's role).
--     Coach devices can't subscribe from any UI yet — that toggle is a
--     separate Phase-1 item — but the fan-out is ready for it.
--
-- Requires the same Vault secrets as the feedback push
-- (app_functions_url, app_service_role_key); skips silently when unset.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_recipient_on_chat_message()
RETURNS TRIGGER AS $$
DECLARE
  v_sender_name     text;
  v_sender_role     text;
  v_functions_url   text;
  v_service_key     text;
  v_body_preview    text;
BEGIN
  -- Feedback messages are handled by notify_student_on_session_feedback.
  IF NEW.session_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets
     WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL
       AND v_service_key IS NOT NULL
       AND v_functions_url <> ''
       AND v_service_key <> ''
    THEN
      -- One lookup covers both ends: in the two-role model the recipient's
      -- surface is simply the opposite of the sender's role, and the
      -- no-name fallback must name the sender's role, not assume "coach"
      -- (profiles created by the hardened handle_new_user default to '').
      SELECT p.full_name, p.role INTO v_sender_name, v_sender_role
        FROM public.profiles p
       WHERE p.id = NEW.sender_id;

      -- Trim to 200 chars so the encrypted push payload stays under the
      -- 4 KB Web Push limit. iOS only shows ~200 chars on the lock screen.
      v_body_preview := LEFT(BTRIM(NEW.body), 200);

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', NEW.recipient_id,
          'payload', jsonb_build_object(
            'title', 'Message from ' || COALESCE(
                       NULLIF(BTRIM(v_sender_name), ''),
                       CASE WHEN v_sender_role = 'coach' THEN 'your coach' ELSE 'your student' END
                     ),
            'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read.'),
            'tag',   'chat-' || NEW.sender_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/'
                     || CASE WHEN v_sender_role = 'coach' THEN 'student' ELSE 'coach' END
                     || '/messages'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the message INSERT; the realtime
    -- badge still updates for open tabs.
    RAISE WARNING 'chat push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_chat_message_push ON public.messages;
CREATE TRIGGER on_chat_message_push
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_recipient_on_chat_message();
