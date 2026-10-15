/**
 * Where signing in returns to.
 *
 * A link into the app opened without a session — a notification, a bookmark,
 * a link a coach pasted — is sent to /login, and the sign-in used to land on
 * the role's home: the link was lost. The page that sends to /login passes
 * where it was in router state (`loginState`), and the login page goes back
 * there (`returnPathFor`).
 *
 * Only to a page of the role that signed in: a path that starts with
 * `/${role}/`. Anything else — another role's page, `/`, a value that is not
 * a string — is the role's home. The value comes from router state, which any
 * page of the app can write, and it is handed to navigate(): the check keeps
 * it a path inside the app. (`//host` and `https://…` never start with
 * `/coach/` or `/student/`.)
 */
export function returnPathFor(role, from) {
  const home = `/${role}`;
  if (typeof from !== 'string' || !from.startsWith(`${home}/`)) return home;
  return from;
}

/**
 * The router state that goes with a redirect to /login from `location`: the
 * path and query the sign-in returns to.
 */
export function loginState(location) {
  return { from: `${location.pathname}${location.search || ''}` };
}
