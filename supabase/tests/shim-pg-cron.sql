-- ============================================================
-- pg_cron, as far as SQL sees it — a stub for pg_cron 1.6.4 on Supabase.
--
-- NOT part of shim.sql. Production does not have the extension switched on,
-- and neither has the database the suite runs on (sl_template): a rest push
-- is sent by the Edge Function there, and nothing happens on a timer. A test
-- about a project that HAS it switches it on in a database of its own:
--
--     const db = await scratchDatabase();
--     await db.enableExtension('pg_cron');
--
-- which runs this file as the platform (the bootstrap superuser) — what the
-- dashboard does under Database → Extensions: CREATE EXTENSION pg_cron, then
-- Supabase's after-create script, which hands the schema to `postgres`.
--
-- What is here is what user SQL sees and calls:
--
--   cron.job                one row per job
--   cron.job_run_details    one row per run of a job
--   cron.schedule(job_name, schedule, command)    makes a job, or replaces the
--                                                 schedule and the command of
--                                                 the caller's job of that name
--   cron.schedule(schedule, command)              a job without a name
--   cron.unschedule(job_name) / cron.unschedule(job_id)
--   cron.alter_job(job_id, schedule, command, database, username, active)
--
-- with the privileges `postgres` holds in a Supabase project: it calls the
-- functions, reads cron.job — and cannot write it: a job is made, changed and
-- removed through the functions, which is what keeps a job from being given
-- to another role. A statement that writes cron.job itself fails here as it
-- would there.
--
-- SHIM LIMITS
--   * NOTHING RUNS A JOB. There is no scheduler: a test runs the command of a
--     job itself, as the job's role, and writes the row of a run itself.
--   * A schedule is checked for its shape — five fields, or 'N seconds' with
--     N from 1 to 59 — not parsed.
--   * A job belongs to the role of the session (SET ROLE included): what
--     pg_cron records for a call that does not come from inside a
--     SECURITY DEFINER function.
--   * The extension is a catalog row, without pg_depend entries — as pg_net
--     and the vault are in shim.sql. So its functions show in a catalog
--     snapshot (catalog.js), on both sides of a comparison alike.
-- ============================================================

CREATE SCHEMA cron;

CREATE SEQUENCE cron.jobid_seq;
CREATE SEQUENCE cron.runid_seq;

CREATE TABLE cron.job (
  jobid    bigint PRIMARY KEY DEFAULT nextval('cron.jobid_seq'),
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT inet_server_port(),
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT true,
  jobname  text,
  CONSTRAINT jobname_username_uniq UNIQUE (jobname, username)
);

CREATE TABLE cron.job_run_details (
  jobid          bigint,
  runid          bigint PRIMARY KEY DEFAULT nextval('cron.runid_seq'),
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);

-- As pg_cron creates them: a role sees and removes what is its own.
ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
CREATE POLICY cron_job_policy ON cron.job USING (username = CURRENT_USER);
ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY cron_job_run_details_policy ON cron.job_run_details USING (username = CURRENT_USER);

-- The functions write cron.job with the rights of the extension's owner, as
-- the C functions of pg_cron do. Arguments are read by position: their names
-- are pg_cron's, and two of them are also columns of the table.
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user text := coalesce(nullif(current_setting('role', true), 'none'), session_user);
  v_id   bigint;
BEGIN
  IF $2 IS NULL
     OR ($2 !~ '^\s*(\S+\s+){4}\S+\s*$' AND $2 !~* '^\s*([1-9]|[1-5][0-9])\s+seconds?\s*$') THEN
    RAISE EXCEPTION 'invalid schedule: %', $2
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Use cron format (e.g. 5 4 * * *), or interval format ''[1-59] seconds''';
  END IF;

  INSERT INTO cron.job AS j (schedule, command, username, jobname)
  VALUES ($2, $3, v_user, $1)
  ON CONFLICT ON CONSTRAINT jobname_username_uniq
  DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING j.jobid INTO v_id;
  RETURN v_id;
END
$$;

CREATE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT cron.schedule(NULL::text, $1, $2) $$;

CREATE FUNCTION cron.unschedule(job_name text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user text := coalesce(nullif(current_setting('role', true), 'none'), session_user);
BEGIN
  DELETE FROM cron.job j WHERE j.jobname = $1 AND j.username = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job ''%''', $1;
  END IF;
  RETURN true;
END
$$;

CREATE FUNCTION cron.unschedule(job_id bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user text := coalesce(nullif(current_setting('role', true), 'none'), session_user);
BEGIN
  DELETE FROM cron.job j WHERE j.jobid = $1 AND j.username = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job %', $1;
  END IF;
  RETURN true;
END
$$;

-- pg_cron lets a superuser alone move a job to another database or role: the
-- stub refuses both for everybody.
CREATE FUNCTION cron.alter_job(
  job_id   bigint,
  schedule text    DEFAULT NULL,
  command  text    DEFAULT NULL,
  database text    DEFAULT NULL,
  username text    DEFAULT NULL,
  active   boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user text := coalesce(nullif(current_setting('role', true), 'none'), session_user);
BEGIN
  IF $4 IS NOT NULL OR $5 IS NOT NULL THEN
    RAISE EXCEPTION 'pg_cron stub: the database and the role of a job are not changed here';
  END IF;
  UPDATE cron.job j
     SET schedule = coalesce($2, j.schedule),
         command  = coalesce($3, j.command),
         active   = coalesce($6, j.active)
   WHERE j.jobid = $1 AND j.username = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % does not exist or you don''t own it', $1;
  END IF;
END
$$;

-- Supabase's after-create script for pg_cron: the schema and its functions go
-- to `postgres`, and so do the tables — except cron.job, which it may read
-- and nothing more. The API roles get nothing: the schema is not theirs to
-- enter.
GRANT USAGE ON SCHEMA cron TO postgres WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA cron TO postgres WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA cron TO postgres WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres WITH GRANT OPTION;
REVOKE ALL ON TABLE cron.job FROM postgres;
GRANT SELECT ON TABLE cron.job TO postgres WITH GRANT OPTION;

-- The row `CREATE EXTENSION pg_cron` leaves — what a migration asks for when
-- it wants to know whether the project has the extension.
INSERT INTO pg_catalog.pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
VALUES (
  pg_nextoid('pg_catalog.pg_extension'::regclass, 'oid', 'pg_catalog.pg_extension_oid_index'::regclass),
  'pg_cron',
  (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin'),
  'pg_catalog'::regnamespace,
  false,
  '1.6.4'
);
