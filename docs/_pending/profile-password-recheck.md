# profile-password-recheck — docs to fold (wave 3, items none)

Each block: target doc, section, then the text to fold in. The package is the client part of review item L5 ("no re-authentication to change the password"); the server part (Secure password change) stays off.

## docs/INVARIANTS.md — UserMenu / profile surface

Add after the bullet that starts "**Student Profile is the avatar-tap destination on every student page.**":

- **Changing the password asks for the current one, and checks it with a sign-in before anything is changed.** `ChangePasswordDialog` in `student/StudentProfile.jsx` runs the checks that need no network first — current password given, new one of 8 characters, both new fields equal — so a new password that would be refused costs no sign-in attempt; then `signIn(user.email, current)` of `useAuth`, and `updatePassword` only when that sign-in returned no error. A wrong password is GoTrue's `invalid_credentials` (or a bare 400 without a code) and says `profilePasswordRecheck.currentWrong`; no network, a rate limit (429) or any other refusal says `profilePasswordRecheck.checkFailed` — never "wrong", and never the server's English. The check is a real sign-in of the same account: auth-js announces it as a `SIGNED_IN` of a session already known, which the provider does not act on (no `replayQueuedWrites`, `signOuts` unchanged), and a failed one leaves the session as it was. `signIn` must keep both properties, or a password change replays the queue or signs the athlete out. One submit runs at a time (a ref, not only the disabled button); Cancel during the check abandons the attempt, so `updatePassword` is never called behind a closed dialog — a change already sent cannot be called back, and its answer is dropped. Success and close clear the three fields. Server-side re-authentication ("Secure password change") stays off (the bullet "Public sign-up is off" under RLS / DB conventions). A forgotten password cannot be changed here: the app has no reset, and the owner hands over a password he chose (`docs/runbook/20-auth-config.md`).

## CLAUDE.md — Feature → files map, row "Student profile"

Replace the row's file list with:

`student/StudentProfile` (`ChangePasswordDialog` — the current password checked with `signIn` before `updatePassword`; strings in the `profilePasswordRecheck` namespace), `hooks/useStudentLifetimeStats`, `hooks/useAuth`, `hooks/useStudents` (`useMyCoach`), `hooks/useGoals` (`useMyGoals`). Tests: `student/StudentProfile.test.jsx` (the dialog: local refusals without a sign-in, wrong and right current password, a check that fails for another reason, double submit, Cancel during the check), `student/StudentProfile.pushToggle.test.jsx`
