-- ============================================================
-- Coach-feedback Web Push fan-out.
--
-- The `notify_student_on_session_feedback` trigger already runs on
-- AFTER INSERT of a coach feedback message (see 2026_04_30_notifications.sql
-- and the unique partial index on `messages.session_id`). It inserts an
-- in-app notification row and stamps `sessions.reviewed_at`. This
-- migration extends it to also fire a Web Push to the student's
-- registered devices via the `send-push` Edge Function.
--
-- pg_net is async: the HTTP call is enqueued and the trigger returns
-- immediately. If the function URL / service-role key Vault secrets
-- aren't set, the push fan-out is skipped silently — the in-app
-- notification path always runs. The block is also wrapped in EXCEPTION
-- so a transient HTTP failure can never roll back the message INSERT.
--
-- Required project secrets (run once via psql or `supabase db query`):
--
--   SELECT vault.create_secret(
--     'https://<project-ref>.supabase.co/functions/v1',
--     'app_functions_url'
--   );
--   SELECT vault.create_secret(
--     '<shared-bearer-secret>',
--     'app_service_role_key'
--   );
--
-- The value stored as `app_service_role_key` is sent verbatim as the
-- `Authorization: Bearer <…>` header to send-push, which compares it
-- to its `INTERNAL_BEARER` env var (set via `supabase secrets set
-- INTERNAL_BEARER=<…>`). The two must be the same string. Any opaque
-- secret works; the legacy service-role JWT is convenient because
-- it's already secret. We avoid SUPABASE_SERVICE_ROLE_KEY for this
-- because Supabase auto-injects an `sb_secret_*` key whose full value
-- isn't retrievable outside the dashboard, so the two ends would
-- drift on newer projects.
--
-- Rotate with:
--   UPDATE vault.secrets SET secret = '<new>'
--    WHERE name = 'app_service_role_key';
--   supabase secrets set INTERNAL_BEARER='<new>'
--
-- Vault stores the value encrypted at rest; only SECURITY DEFINER
-- functions running as `postgres` can read the decrypted view.
-- ============================================================

-- pg_net + vault ship with Supabase but only enable on demand.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name      text;
  v_session_title   text;
  v_functions_url   text;
  v_service_key     text;
  v_body_preview    text;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_coach_name
    FROM public.profiles p
   WHERE p.id = NEW.sender_id;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  -- Sending feedback also marks the session reviewed (idempotent).
  UPDATE public.sessions
     SET reviewed_at = NEW.created_at
   WHERE id = NEW.session_id
     AND reviewed_at IS NULL;

  -- In-app notification (existing behavior, unchanged).
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    NEW.recipient_id,
    'session_feedback',
    jsonb_build_object(
      'session_id',       NEW.session_id,
      'session_title',    v_session_title,
      'coach_profile_id', NEW.sender_id,
      'coach_name',       v_coach_name,
      'message_id',       NEW.id
    )
  );

  -- Web Push fan-out (best-effort). Skips silently when the Vault
  -- secrets aren't configured so this migration can be applied before
  -- the project ref and service-role key are stashed, and so a project
  -- that's deliberately not using push isn't forced to.
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
            'title', 'Feedback from ' || COALESCE(v_coach_name, 'your coach'),
            'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read your coach''s feedback.'),
            'tag',   'feedback-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/student/session/' || NEW.session_id::text
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the in-app notification path. The
    -- coach's feedback INSERT succeeded; the bell will still light up.
    RAISE WARNING 'send-push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger already exists from 2026_04_30_notifications.sql; the function
-- replacement above takes effect without re-creating the trigger.
