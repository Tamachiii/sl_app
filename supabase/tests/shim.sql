-- ============================================================
-- Supabase shim for the DB test suite (supabase/tests/).
--
-- schema.sql is written for a Supabase project: it assumes roles, schemas,
-- functions and default privileges that the platform creates before the first
-- line of user SQL runs. This file recreates exactly that starting point on a
-- bare PostgreSQL 17, so schema.sql can then be loaded UNMODIFIED.
--
-- Order of operations (see postgres.js):
--   1. this file, as the bootstrap superuser `supabase_admin`, inside the
--      database `sl_bare` — once per cluster, because the roles it creates
--      are cluster-wide;
--   2. a copy of that database, then supabase/schema.sql in it, as `postgres`
--      — the same NON-superuser role the Supabase SQL editor and `supabase db
--      query` run as. (The parity test makes another copy and loads the
--      production baseline plus the migrations instead.)
--
-- Nothing runs after schema.sql, on purpose. The ACLs that make `anon` able
-- to EXECUTE every public function come from ALTER DEFAULT PRIVILEGES below,
-- which is how production gets them. A blanket GRANT issued after the load
-- would produce the same catalog today but would silently re-grant whatever a
-- future `REVOKE … FROM anon` in schema.sql takes away — the fix would be
-- untestable. With default privileges the statements in schema.sql meet the
-- same starting ACLs as in production and behave the same way.
--
-- Every deviation from a real project is marked "SHIM LIMIT".
-- ============================================================

-- ------------------------------------------------------------
-- 1. Roles (cluster-wide)
-- ------------------------------------------------------------

-- The role user SQL runs as. Supabase demotes it from superuser
-- (10000000000000_demote-postgres.sql): it owns everything in `public`,
-- bypasses RLS, and is otherwise subject to ordinary GRANTs. SECURITY DEFINER
-- functions in schema.sql therefore run as THIS role, not as a superuser.
-- Passwords are throwaway: the cluster listens on 127.0.0.1 for one test run.
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD 'postgres';

-- API roles. `anon` = a request carrying only the public anon key (no user
-- JWT); `authenticated` = a signed-in user; `service_role` = Edge Functions.
CREATE ROLE anon          NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS;

-- PostgREST's login role: it holds no privilege of its own and does
-- SET LOCAL ROLE <anon|authenticated|service_role> per request.
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'postgres';
GRANT anon, authenticated, service_role TO authenticator;

-- `postgres` can impersonate the API roles too — this is what the dashboard's
-- "role impersonation" and `supabase test db` rely on, and what harness.js
-- does: SET LOCAL ROLE + request.jwt.claims inside a transaction.
GRANT anon, authenticated, service_role TO postgres;

-- Owners of the platform schemas.
CREATE ROLE supabase_auth_admin    NOLOGIN NOINHERIT CREATEROLE;
CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT CREATEROLE;

-- `postgres` may switch off triggers for a statement, as a dump restore does
-- (`SET session_replication_role = replica` opens every Supabase data dump).
GRANT SET ON PARAMETER session_replication_role TO postgres;

ALTER ROLE postgres            SET search_path = "$user", public, extensions;
ALTER ROLE supabase_admin      SET search_path = "$user", public, extensions;
ALTER ROLE supabase_auth_admin SET search_path = auth;

-- The test database belongs to `postgres`, which makes it the effective owner
-- of schema `public` (owned by pg_database_owner since PG 15) and lets it own
-- the realtime publication. anon/authenticated get USAGE only — no CREATE.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO postgres', current_database());
END $$;

-- ------------------------------------------------------------
-- 2. Extensions
-- ------------------------------------------------------------
CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
GRANT ALL   ON SCHEMA extensions TO postgres;

-- Real contrib builds, as in production (pgcrypto 1.3, uuid-ossp 1.1).
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 3. auth
-- ------------------------------------------------------------
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL   ON SCHEMA auth TO postgres, supabase_auth_admin;

-- The columns GoTrue maintains that SQL is likely to touch. SHIM LIMIT: a
-- subset of the real table, and `id` has a default here (GoTrue supplies it).
CREATE TABLE auth.users (
  instance_id        uuid,
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud                varchar(255),
  role               varchar(255),
  email              varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  raw_app_meta_data  jsonb,
  raw_user_meta_data jsonb,
  is_super_admin     boolean,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  phone              text,
  banned_until       timestamptz,
  deleted_at         timestamptz,
  is_sso_user        boolean NOT NULL DEFAULT false,
  is_anonymous       boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX users_email_partial_key ON auth.users (email) WHERE is_sso_user = false;
ALTER TABLE auth.users OWNER TO supabase_auth_admin;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- `postgres` keeps full DML + REFERENCES + TRIGGER on auth tables after the
-- demotion: that is what lets schema.sql declare `REFERENCES auth.users(id)`
-- and `CREATE TRIGGER on_auth_user_created … ON auth.users`. The API roles
-- get nothing — the auth schema is not exposed.
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres;

-- Verbatim from GoTrue's migrations: the claims PostgREST puts in
-- request.jwt.claims for the current transaction.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

ALTER FUNCTION auth.uid()   OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role()  OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.jwt()   OWNER TO supabase_auth_admin;

-- ------------------------------------------------------------
-- 4. storage
-- ------------------------------------------------------------
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;
GRANT ALL   ON SCHEMA storage TO postgres, supabase_storage_admin;

CREATE TABLE storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  owner              uuid,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  public             boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text
);

CREATE TABLE storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets(id),
  name             text,
  owner            uuid,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata         jsonb,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version          text,
  owner_id         text,
  user_metadata    jsonb,
  UNIQUE (bucket_id, name)
);

ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- The Storage API runs each request as the caller's role, so the API roles
-- hold table privileges and RLS is the gate.
GRANT ALL ON ALL TABLES IN SCHEMA storage TO postgres, anon, authenticated, service_role;

CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  _parts text[];
BEGIN
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
END
$$;

CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  _parts text[];
BEGIN
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
END
$$;

CREATE FUNCTION storage.extension(name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  _filename text;
BEGIN
  _filename := storage.filename(name);
  return reverse(split_part(reverse(_filename), '.', 1));
END
$$;

ALTER FUNCTION storage.foldername(text) OWNER TO supabase_storage_admin;
ALTER FUNCTION storage.filename(text)   OWNER TO supabase_storage_admin;
ALTER FUNCTION storage.extension(text)  OWNER TO supabase_storage_admin;

-- SHIM LIMIT: in production `postgres` may CREATE POLICY on storage.objects
-- without owning it, through supautils' `policy_grants`. That extension is not
-- available here, so membership in the owning role stands in for it. Side
-- effect: DDL on storage.* that production would refuse succeeds here.
GRANT supabase_storage_admin TO postgres;

-- ------------------------------------------------------------
-- 5. vault  (stub for supabase_vault 0.3.1)
-- ------------------------------------------------------------
-- SHIM LIMIT: no encryption. `decrypted_secret` is the stored text. Empty by
-- default, which is the "push not configured" branch of send_push_event() —
-- the one function of schema.sql that reads it; a test opts in with
-- harness.enablePush().
CREATE SCHEMA vault;

CREATE TABLE vault.secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE,
  description text NOT NULL DEFAULT '',
  secret      text NOT NULL,
  key_id      uuid,
  nonce       bytea,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW vault.decrypted_secrets AS
  SELECT id, name, description, secret, secret AS decrypted_secret,
         key_id, nonce, created_at, updated_at
    FROM vault.secrets;

CREATE FUNCTION vault.create_secret(
  new_secret      text,
  new_name        text DEFAULT NULL,
  new_description text DEFAULT '',
  new_key_id      uuid DEFAULT NULL
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO vault.secrets (secret, name, description, key_id)
  VALUES (new_secret, new_name, new_description, new_key_id)
  RETURNING id
$$;

CREATE FUNCTION vault.update_secret(
  secret_id       uuid,
  new_secret      text DEFAULT NULL,
  new_name        text DEFAULT NULL,
  new_description text DEFAULT NULL,
  new_key_id      uuid DEFAULT NULL
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE vault.secrets
     SET secret      = COALESCE(new_secret, secret),
         name        = COALESCE(new_name, name),
         description = COALESCE(new_description, description),
         key_id      = COALESCE(new_key_id, key_id),
         updated_at  = now()
   WHERE id = secret_id
$$;

-- Only `postgres` and `service_role` reach the vault, and only to read,
-- delete, or go through the two functions: a SECURITY DEFINER function (owner
-- postgres) can read a secret, a SECURITY INVOKER one called by a signed-in
-- user cannot.
GRANT USAGE ON SCHEMA vault TO postgres, service_role;
GRANT SELECT, DELETE ON vault.secrets, vault.decrypted_secrets TO postgres, service_role;
REVOKE ALL ON FUNCTION vault.create_secret(text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault.update_secret(uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault.create_secret(text, text, text, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION vault.update_secret(uuid, text, text, text, uuid) TO postgres, service_role;

-- ------------------------------------------------------------
-- 6. net  (stub for pg_net 0.20.0)
-- ------------------------------------------------------------
-- pg_net queues an HTTP request and returns its id; a background worker sends
-- it, and writes what came back into net._http_response, where it stays for
-- six hours (pg_net.ttl). The stub keeps the queue and never sends, so a test
-- asserts the push fan-out by reading net.http_request_queue.
-- SHIM LIMITS: `body` is jsonb (bytea in pg_net) so it can be asserted on
-- directly; and nothing ever answers — net._http_response stays empty until a
-- test writes the answer of a request into it itself.
CREATE SCHEMA net;

CREATE TABLE net.http_request_queue (
  id                   bigserial PRIMARY KEY,
  method               text NOT NULL,
  url                  text NOT NULL,
  params               jsonb,
  headers              jsonb,
  body                 jsonb,
  timeout_milliseconds int,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per request that was sent: what the other side answered
-- (status_code, content), or why nothing came back (timed_out, error_msg).
-- The columns of pg_net; `id` is the id net.http_post gave the request.
CREATE TABLE net._http_response (
  id           bigint,
  status_code  integer,
  content_type text,
  headers      jsonb,
  content      text,
  timed_out    boolean,
  error_msg    text,
  created      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX _http_response_created_idx ON net._http_response (created);

-- Same signature and defaults as pg_net. Set the transaction-local GUC
--   select set_config('shim.http_post_fails', 'on', true);
-- to make the next calls raise — send_push_event() is its one caller in
-- schema.sql, and every function that asks it for a push wraps that call in
-- EXCEPTION WHEN OTHERS, which is worth testing.
CREATE FUNCTION net.http_post(
  url                  text,
  body                 jsonb DEFAULT '{}'::jsonb,
  params               jsonb DEFAULT '{}'::jsonb,
  headers              jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds int   DEFAULT 5000
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = net AS $$
DECLARE
  v_id bigint;
BEGIN
  IF current_setting('shim.http_post_fails', true) = 'on' THEN
    RAISE EXCEPTION 'pg_net shim: forced failure (shim.http_post_fails = on)';
  END IF;
  INSERT INTO net.http_request_queue (method, url, params, headers, body, timeout_milliseconds)
  VALUES ('POST', url, params, headers, body, timeout_milliseconds)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Supabase's after-create hook for pg_net: PUBLIC revoked, then granted to
-- the API roles by name.
GRANT USAGE ON SCHEMA net TO postgres, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, int)
  TO postgres, anon, authenticated, service_role;
-- Harness-only: lets a test read and reset the queue as `postgres`.
GRANT SELECT, DELETE ON net.http_request_queue TO postgres;
-- `postgres` reads the answers, as it does in a Supabase project (the
-- dashboard's own advice for a request that went wrong is `select * from
-- net._http_response`). INSERT and DELETE are harness-only: a test writes the
-- answers the absent worker would have written.
GRANT SELECT, INSERT, DELETE ON net._http_response TO postgres;

-- ------------------------------------------------------------
-- 7. Make `CREATE EXTENSION IF NOT EXISTS pg_net / supabase_vault` a no-op
-- ------------------------------------------------------------
-- schema.sql issues both statements. Neither extension ships with the npm
-- Postgres binaries, and IF NOT EXISTS only skips when a pg_extension row
-- exists — otherwise the server looks for a control file and fails. The two
-- stubs above are therefore registered by hand, with production's versions.
-- SHIM LIMIT: catalog rows only (no pg_depend entries).
--
-- pg_cron is ABSENT, as in production, where nobody has switched it on. A
-- test about a project that has it switches a stub on in a database of its
-- own — shim-pg-cron.sql, through scratchDatabase().enableExtension('pg_cron')
-- in harness.js — the way the owner would in the dashboard.
INSERT INTO pg_catalog.pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
VALUES (
  pg_nextoid('pg_catalog.pg_extension'::regclass, 'oid', 'pg_catalog.pg_extension_oid_index'::regclass),
  'pg_net',
  (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin'),
  'extensions'::regnamespace,
  false,
  '0.20.0'
);

INSERT INTO pg_catalog.pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
VALUES (
  pg_nextoid('pg_catalog.pg_extension'::regclass, 'oid', 'pg_catalog.pg_extension_oid_index'::regclass),
  'supabase_vault',
  (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin'),
  'vault'::regnamespace,
  false,
  '0.3.1'
);

-- ------------------------------------------------------------
-- 8. Realtime
-- ------------------------------------------------------------
-- Empty publication; schema.sql adds messages and notifications to it.
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime OWNER TO postgres;

-- ------------------------------------------------------------
-- 9. Default privileges on schema public  (the part that matters most)
-- ------------------------------------------------------------
-- From Supabase's initial schema. Every table, sequence and function created
-- in `public` by `postgres` (or by supabase_admin) is granted IN FULL to the
-- three API roles, by name. Consequences the suite exists to exercise:
--   * anon and authenticated hold arwdDxtm on every table — RLS is the only
--     gate, and a table without RLS is world-writable;
--   * a function is executable by anon the moment it is created, and
--     `REVOKE ALL ON FUNCTION … FROM public` does NOT undo that: it removes
--     the PUBLIC entry and leaves anon's own grant in place.
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
