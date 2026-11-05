// What the loopback receiver does with a sign-in that comes back from the browser,
// kept apart from Electron so it can be unit tested.
//
// A sign-in comes back in one of two shapes:
//   * PKCE (the terminal's own sign-in): `?code=...` in the query, which the
//     receiver sees and appends to the original redirect_to.
//   * implicit (backquant.com's sign-in, flowType 'implicit'): the session itself,
//     `#access_token=...&refresh_token=...`, in the fragment. A browser never sends
//     the fragment to a server, so until 0.3.5 the receiver saw a bare /callback and
//     answered "Sign-in incomplete": every Google, GitHub or Discord sign-in started on
//     backquant.com failed in the app. The page served for a bare /callback now reads
//     its own fragment and posts it back (FRAGMENT_PATH), and the app opens the
//     original redirect_to with the same fragment, where backquant.com's client
//     reads the session as it does in a browser.
// Errors come back in the query, the fragment or both; either way they are shown.

const { LOOPBACK_PORT, allowedInApp } = require('./urls');

const LOOPBACK_ORIGIN = `http://127.0.0.1:${LOOPBACK_PORT}`;
const CALLBACK_PATH = '/callback';
const FRAGMENT_PATH = '/callback/fragment';
// A session fragment is a few KB (two tokens and the provider's); anything far
// larger is not one.
const MAX_FRAGMENT_BYTES = 32 * 1024;
// The fragment keys a Supabase implicit sign-in carries. Only these are passed on.
const SESSION_KEYS = [
  'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type',
  'provider_token', 'provider_refresh_token', 'type',
];

function errorMessage(params) {
  return params.get('error_description') || params.get('error') || '';
}

/** A /callback request's query: a PKCE code, an error, or neither (look at the fragment). */
function fromQuery(params) {
  const err = errorMessage(params);
  if (err) return { kind: 'error', message: err };
  if (params.get('code')) return { kind: 'code' };
  return { kind: 'none' };
}

/** A fragment posted back by the callback page: an implicit session, an error, or neither. */
function fromFragment(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_FRAGMENT_BYTES) return { kind: 'none' };
  const params = new URLSearchParams(text.replace(/^#/, ''));
  const err = errorMessage(params);
  if (err) return { kind: 'error', message: err };
  if (!params.get('access_token') || !params.get('refresh_token')) return { kind: 'none' };
  const keep = new URLSearchParams();
  for (const k of SESSION_KEYS) {
    const v = params.get(k);
    if (v != null) keep.set(k, v);
  }
  return { kind: 'session', fragment: keep.toString() };
}

/** Where the window goes with a PKCE code: the original redirect_to plus the callback's query. */
function withQuery(dest, params) {
  const target = new URL(dest);
  for (const [k, v] of params) target.searchParams.append(k, v);
  return target.toString();
}

/** Where the window goes with an implicit session: the original redirect_to, fragment set. */
function withFragment(dest, fragment) {
  const target = new URL(dest);
  target.hash = fragment;
  return target.toString();
}

/** Only our own sign-in page may hand a fragment over: a browser sets Origin on a POST
 *  and a page cannot forge it, so another site cannot post a session of its own into
 *  a sign-in that is waiting. */
function fragmentPostAllowed(method, origin) {
  return method === 'POST' && origin === LOOPBACK_ORIGIN;
}

/** The redirect_to the window may be sent to: one of the app's own pages. */
function deliverable(dest) {
  try {
    const u = new URL(dest);
    return (u.protocol === 'https:' || u.protocol === 'http:') && allowedInApp(dest);
  } catch {
    return false;
  }
}

// Served for a bare /callback. Reads the fragment, posts it back and shows the answer;
// with no fragment it says the sign-in did not finish. The fragment is removed from the
// address first so the tokens do not stay in the browser's history.
const PICKUP_SCRIPT = `(function () {
  var h = location.hash ? location.hash.slice(1) : '';
  if (!h) return;
  history.replaceState(null, '', location.pathname);
  var t = document.querySelector('h1'), p = document.querySelector('p');
  t.textContent = 'Finishing sign-in';
  p.textContent = '';
  fetch(${JSON.stringify(FRAGMENT_PATH)}, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: h })
    .then(function (r) { return r.json(); })
    .then(function (j) { t.textContent = j.title; p.textContent = j.body || ''; })
    .catch(function () { t.textContent = 'Sign-in incomplete'; p.textContent = 'Return to BackQuant Terminal and try again.'; });
})();`;

module.exports = {
  LOOPBACK_ORIGIN,
  CALLBACK_PATH,
  FRAGMENT_PATH,
  MAX_FRAGMENT_BYTES,
  PICKUP_SCRIPT,
  deliverable,
  fragmentPostAllowed,
  fromFragment,
  fromQuery,
  withFragment,
  withQuery,
};
