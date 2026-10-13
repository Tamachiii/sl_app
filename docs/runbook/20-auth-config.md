# 20 — Auth settings: sign-up off, site URL, password length

| | |
|---|---|
| Where | Supabase dashboard → Authentication. No SQL file, no migration, nothing to deploy |
| Kind | four settings changed by hand · no table and no row is touched |
| Wave / checkpoint | 0 / A0 — in any order with migrations 01 and 02 |
| Findings | L5 (medium) |
| Check | read-only, before and after (section 1) |

This page is for the person who owns the Supabase project. These settings exist in the dashboard only: nothing in the repository changes them or reads them from production, and no agent does as part of its work on a package. They were set at Checkpoint A0, by Claude at the owner's request (`docs/RUNBOOK.md`, "Who runs a checkpoint"). The last section says why the repository holds no copy.

## What is wrong today

The values the review read on 2026-09-30, and the ones the app needs:

| Setting (API name) | Today | Wanted | What the gap allows |
|---|---|---|---|
| `disable_signup` | `false` | `true` | Anyone who has the anon key — it is in the app's JavaScript — can create an account through the API. The app has no sign-up screen and never calls that endpoint |
| `site_url` | `http://localhost:3000` | `https://tamachiii.github.io/sl_app/` | Every link in an e-mail Supabase sends (invitation, password recovery) leads to `localhost` |
| `uri_allow_list` | empty | `https://tamachiii.github.io/sl_app/**` | Nothing today: a link may always lead to the site URL. The entry is there for the e-mail links of wave 6 |
| `password_min_length` | `6` | `8` | The app's change-password dialog asks for 8 characters; the API accepts 6 |

An account somebody creates for themselves is a signed-in `student` with no coach. It reads nobody's data. It can write: error reports that land in the coach's triage list, 30 MB videos into the bucket, push subscriptions and schedules that call the Edge Functions and, until migration 05, a `students` row that names itself a coach.

## 1. Before: read what is there

### The settings anyone can read

From the root of the checkout that holds the `.env`. The command reads the project URL and the anon key from that file, sends one `GET` to `/auth/v1/settings` and changes nothing:

```bash
node --env-file=.env --input-type=module -e '
const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key } = process.env;
const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
const settings = await res.json();
const enabled = Object.keys(settings.external).filter((name) => settings.external[name]);
console.log(`disable_signup: ${settings.disable_signup}`);
console.log(`mailer_autoconfirm: ${settings.mailer_autoconfirm}`);
console.log(`ways to sign in: ${enabled.join(", ") || "none"}`);
'
```

It prints three lines:

| line | today | after the four steps |
|---|---|---|
| `disable_signup` | `false` | `true` |
| `mailer_autoconfirm` | `false` | `false` |
| `ways to sign in` | `email` | `email` |

If it does not print the *today* column:

- **`disable_signup: true`** — sign-up is already off. Do steps 2 to 4 all the same.
- **`mailer_autoconfirm: true`** — an e-mail address is accepted without being confirmed. In step 1, turn **Confirm email** back on.
- **`ways to sign in`** lists something besides `email` (`anonymous_users`, `phone`, `google` …) — a way in that the app does not use is switched on. Switch it off on the page of step 1.
- **`ways to sign in: none`** — the Email provider is off and nobody can sign in. Switch it on (step 4 opens its panel).
- **`node: .env: not found`** — this folder has no `.env`. Run the command from the root of the main checkout.
- **`HTTP 401`** — the key in `.env` is not this project's anon key.
- **`fetch failed`** — no network, or the URL in `.env` is wrong.

The endpoint is the public one a sign-in form reads. Of the four settings it shows the first only, next to two that must not move. The site URL, the redirect list and the password length cannot be read from outside; their check is the dashboard, reloaded (section 3).

### Who has an account

Sign-up has been open since the project was created. Closing it does not remove an account made while it was open, so read the list once. One read-only query, in the SQL editor (without the first and the last line) or:

```bash
supabase db query --linked "
select u.email,
       u.created_at::date as created,
       u.email_confirmed_at is not null as confirmed,
       u.last_sign_in_at::date as last_sign_in,
       coalesce(p.role, 'no profile') as role,
       coalesce(nullif(c.full_name, ''), s.coach_id::text, '-') as coach,
       (select count(*) from public.students a where a.coach_id = u.id)::int as athletes
from auth.users u
left join public.profiles p on p.id = u.id
left join public.students s on s.profile_id = u.id
left join public.profiles c on c.id = s.coach_id
order by u.created_at, u.email
"
```

One line per account, oldest first. A clean result:

- you know every e-mail address;
- `role` reads `coach` on the coaches you appointed, and on nobody else;
- a `coach` line has `-` under `coach`;
- a `student` line has `0` under `athletes`, and its coach's name under `coach`.

What the other cases are:

- **an address you do not know** — an account somebody made through the open sign-up. With `confirmed` = `false` it never confirmed its address and cannot sign in.
- **`student`, `-` under `coach`** — an account with no coach: an athlete you created and have not linked yet, or a stranger's.
- **`student`, `athletes` above `0`** — the account wrote a `students` row that names itself a coach (finding L2; migration 05 closes that).
- **`coach`, a name under `coach`** — somebody listed that coach as their athlete: the same forged row, seen from the other side.
- **`no profile`** — an account without its `profiles` row; it cannot use the app.

For any of these: do not delete the account yet. Note the line and report it — the account may own rows (a forged `students` row, library entries, error reports, videos) that are easier to list while it still exists. Then go on with the four steps: closing sign-up does not wait for the answer.

## 2. The four steps

Dashboard → the project → **Authentication**. The dashboard is rearranged from time to time: if a label is not where this page says, look for the words in bold anywhere under Authentication. The API names of the table above do not change.

### Step 1 — sign-up off

**Sign In / Providers** (`https://supabase.com/dashboard/project/_/auth/providers`) → block *User Signups*:

- **Allow new users to sign up**: off.
- **Confirm email**: stays on. **Allow anonymous sign-ins**: stays off.
- **Save changes**.

Do not switch off the **Email** provider in the list further down the page. That switch stops *sign-in*, for everyone.

### Step 2 — site URL

**URL Configuration** (`https://supabase.com/dashboard/project/_/auth/url-configuration`) → **Site URL**:

```text
https://tamachiii.github.io/sl_app/
```

With the final slash. **Save changes**.

### Step 3 — redirect URLs

Same page → **Redirect URLs** → **Add URL**:

```text
https://tamachiii.github.io/sl_app/**
```

That entry and no other. `tamachiii.github.io` also serves the pages of your other repositories, so do not allow `https://tamachiii.github.io/**`. If the list holds anything else, remove it (the review found it empty).

### Step 4 — passwords of 8 characters

**Sign In / Providers** → **Email** in the provider list → **Minimum password length**: `8` → **Save**.

In the same panel, leave **Enable Email provider** on, **Secure password change** off and **Password requirements** at none ("Leave these as they are", below, says why).

## 3. After

1. Run the check of section 1 again. It prints the third column of its table: `disable_signup: true`, the two other lines unchanged. The setting takes a few seconds to reach the API; if the line still reads `false`, run the command again after half a minute.
2. Reload the two dashboard pages and read the four values back. A field that was edited and not saved shows its old value after a reload.
3. Open the app in a private window and sign in. It works as before.

## What changes

**For the app that is deployed today: nothing.** It has no sign-up screen. Sign-in is untouched, and a password that is in use keeps working even if it has fewer than 8 characters: the length is checked when a password is set, not when it is used. The app's change-password dialog already refuses fewer than 8.

**For somebody who calls the API with the anon key:** creating an account answers `Signups not allowed for this instance` (`signup_disabled`), and setting a password of 6 or 7 characters is refused as weak.

**For you:**

- You create accounts as before: Dashboard → Authentication → Users → **Add user** → *Create new user*, with a password of 8 characters or more. That does not go through public sign-up, and neither does *Send invitation*.
- A script of your own that calls `signUp` with the anon key stops working. That is the door being closed.
- An e-mail sent from the dashboard (invitation, password recovery) now links to the app and no longer to `localhost`. The app has no screen for such a link yet: that is wave 6. Until then, keep handing over a password you chose and let the athlete change it in their profile.

## Leave these as they are

The first four look like hardening steps, and each breaks the app that is deployed. The last two are right as they are:

| Setting | Leave it | Turned the other way |
|---|---|---|
| **Enable Email provider** | on | nobody can sign in |
| **Enable Captcha protection** (Attack Protection) | off | sign-in needs a captcha answer the app does not send: nobody can sign in |
| **Secure password change** | off | in a session older than a day, changing the password needs a code sent by e-mail. The app has no field for it, and the built-in sender allows 2 e-mails an hour. The app will ask for the current password itself (wave 3) |
| **Password requirements** (digits, symbols …) | none | the app checks the length only, so the athlete would get an untranslated refusal from the server |
| **Confirm email** | on | an address would be accepted without proof |
| **Allow anonymous sign-ins** | off | accounts without an e-mail address |

## Options that need something outside the project

Not steps of this checkpoint, and nothing waits for them:

- **Leaked-password protection** (*Prevent use of leaked passwords*): paid plan only. The project is on the free plan, so the Security Advisor keeps its warning `auth_leaked_password_protection`. That is expected.
- **Custom SMTP sender**: needs an account with an e-mail provider. The built-in sender is limited to 2 e-mails an hour and may only deliver to the members of the project's own team. Nothing uses it before wave 6 (invitations and password reset in the app); its steps come with that wave.

## Never: `supabase config push`

`supabase config push` sends `supabase/config.toml` to the project, Auth settings included. The repository's file (it arrives in wave 1) only says which Edge Functions check the caller's token. It has no `[auth]` section on purpose, and `src/test/authConfig.test.js` keeps it that way.

For a setting the file does not give, the CLI uses its own default, and its defaults are the problem this page fixes: sign-up on, site URL `http://127.0.0.1:3000`, passwords of 6 characters (what `supabase init` of CLI 2.109 writes). A push would put them back.

So the settings are written down, not mirrored: the wanted values are the table at the top of this page and in `docs/ENVIRONMENT.md`. If one has to change, change it in the dashboard and in those two tables.

## Undo

Each step is one field: put back the value of the *Today* column. There is no known reason to — the app uses none of the four.

If sign-in stops working after these steps, it is not one of the four. Run the check: `ways to sign in` must list `email`. Then look at the table of "Leave these as they are".

## The rest of finding L5

This page closes the configuration part. The others ship elsewhere:

| Part | Where | When |
|---|---|---|
| An athlete uploads a video only for an exercise of their own program | migration 08 | Checkpoint A2 |
| An account cannot name itself a coach, or write a library | migration 05 | Checkpoint A2 |
| The change-password dialog asks for the current password | client | deploy of wave 3 |
| Invitations and password reset in the app | client and an Edge Function | wave 6, with a custom SMTP sender |
