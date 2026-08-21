-- ============================================================
-- Phase 4: a session's weekday becomes a RECOMMENDATION, not a commitment.
--
-- `sessions.day_number` was NOT NULL, so every session had to claim a weekday
-- whether or not the coach meant one. That is what made a session "due" on a
-- day and therefore "missed" the moment the day passed — the cascade the whole
-- refactor is unwinding. Nullable means "no recommended day", which until now
-- had no way to be expressed at all.
--
-- Nothing is backfilled: existing weekdays stay exactly as authored. They are
-- simply advice from here on, and the coach can clear one.
--
-- Note for anyone reading the column later: it has always been a WEEKDAY
-- (1 = Monday … 7 = Sunday), never an ordinal position in the week. The
-- student draft builder used to write it as an ordinal — a 5th session became
-- "Friday" — which is fixed client-side in the same change as this migration.
-- ============================================================

ALTER TABLE public.sessions ALTER COLUMN day_number DROP NOT NULL;

COMMENT ON COLUMN public.sessions.day_number IS
  'Recommended weekday, 1 = Monday … 7 = Sunday. NULL = no recommendation. '
  'Advisory only: order within a program comes from sort_order, and nothing '
  'is "missed" for being trained on a different day.';
