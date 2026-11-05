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
//     backquant.com failed in the app. The page served for /callback now reads its own
//     fragment and posts it back (FRAGMENT_PATH), and the app opens the original
//     redirect_to with the same fragment, where backquant.com's client reads the
//     session as it does in a browser.
// Errors come back in the query, the fragment or both; either way they are shown.
//
// Binding. An implicit session, unlike a PKCE code, is not tied to the sign-in that
// asked for it: any page could open the loopback with a session of its own in the
// fragment and sign the app into that account. So each sign-in gets a random nonce,
// carried in the loopback redirect_to (`/callback?s=<nonce>`). Supabase returns to that
// exact address (it accepts it: probed 2026-11-05), so only the browser that ran this
// sign-in has the nonce, and /callback, an error on it and the fragment post all
// require it. A waiting sign-in also expires (PENDING_TTL_MS).

const crypto = require('node:crypto');
const { LOOPBACK_PORT } = require('./urls');

const LOOPBACK_HOST = `127.0.0.1:${LOOPBACK_PORT}`;
const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}`;
const CALLBACK_PATH = '/callback';
const FRAGMENT_PATH = '/callback/fragment';
// A sign-in left waiting longer than this is dropped (a browser tab left open, an
// abandoned provider page).
const PENDING_TTL_MS = 10 * 60 * 1000;
// A session fragment is a few KB (two tokens and the provider's); anything far
// larger is not one.
const MAX_FRAGMENT_BYTES = 32 * 1024;
// The fragment keys a Supabase implicit sign-in carries. Only these are passed on.
const SESSION_KEYS = [
  'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type',
  'provider_token', 'provider_refresh_token', 'type',
];
// The only hosts a sign-in result is delivered to, over https: the website (served on
// www, the bare domain redirects there) and the terminal.
const DELIVER_HOSTS = new Set(['www.backquant.com', 'backquant.com', 'terminal.backquant.com']);

/** A fresh nonce for one sign-in: 192 random bits, URL-safe. */
function newNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

/** A waiting sign-in: where to deliver it, its nonce, when it started. */
function newPending(dest, now = Date.now()) {
  return { dest, nonce: newNonce(), at: now };
}

/** True when `pending` is live and `nonce` is its own (constant-time compare). */
function pendingMatches(pending, nonce, now = Date.now()) {
  if (!pending || typeof nonce !== 'string' || !nonce) return false;
  if (now - pending.at > PENDING_TTL_MS) return false;
  const a = Buffer.from(pending.nonce);
  const b = Buffer.from(nonce);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True while `pending` is waiting and has not expired. */
function pendingLive(pending, now = Date.now()) {
  return !!pending && now - pending.at <= PENDING_TTL_MS;
}

/** Only requests addressed to the loopback by its own name are served: a page on
 *  another name that resolves here (DNS rebinding) gets nothing. */
function hostAllowed(host) {
  return host === LOOPBACK_HOST;
}

function errorMessage(params) {
  return params.get('error_description') || params.get('error') || '';
}

/** A /callback request's query: a PKCE code, an error, or neither (look at the fragment). */
function fromQuery(params) {
  const err = errorMessage(params);
  if (err) return { kind: 'error', message: err };
  if (params.get('code')) return { kind: 'code', code: params.get('code') };
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

/** The fragment post's body: `{ s, fragment }` as JSON. Null when it is not that. */
function parsePost(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.s === 'string' && typeof j.fragment === 'string') return { nonce: j.s, fragment: j.fragment };
  } catch { /* not JSON */ }
  return null;
}

/** Where the window goes with a PKCE code: the original redirect_to plus the code
 *  (nothing else from the callback's query is passed on). */
function withCode(dest, code) {
  const target = new URL(dest);
  target.searchParams.set('code', code);
  return target.toString();
}

/** Where the window goes with an implicit session: the original redirect_to, fragment set. */
function withFragment(dest, fragment) {
  const target = new URL(dest);
  target.hash = fragment;
  return target.toString();
}

/** Only our own sign-in page may hand a fragment over: a browser sets Origin on a POST
 *  and a page cannot forge it. (The nonce is what ties the post to the sign-in.) */
function fragmentPostAllowed(method, origin) {
  return method === 'POST' && origin === LOOPBACK_ORIGIN;
}

/** The redirect_to the window may be sent to: https on one of DELIVER_HOSTS. */
function deliverable(dest) {
  try {
    const u = new URL(dest);
    return u.protocol === 'https:' && DELIVER_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

// Served for /callback. Reads the fragment and this sign-in's nonce, clears both from
// the address (so the tokens do not stay in the browser's history), posts them back and
// shows the answer; with no fragment it says the sign-in did not finish.
const PICKUP_SCRIPT = `(function () {
  var h = location.hash ? location.hash.slice(1) : '';
  var s = new URLSearchParams(location.search).get('s') || '';
  history.replaceState(null, '', location.pathname);
  if (!h) return;
  var t = document.querySelector('h1'), p = document.querySelector('p');
  t.textContent = 'Finishing sign-in';
  p.textContent = '';
  fetch(${JSON.stringify(FRAGMENT_PATH)}, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ s: s, fragment: h }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { t.textContent = j.title; p.textContent = j.body || ''; })
    .catch(function () { t.textContent = 'Sign-in incomplete'; p.textContent = 'Return to BackQuant Terminal and try again.'; });
})();`;

const PICKUP_SCRIPT_HASH = crypto.createHash('sha256').update(PICKUP_SCRIPT).digest('base64');

// Every loopback answer: never framed, never cached, no referrer, and on pages only the
// pickup script may run and it may only call back to the loopback.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    `default-src 'none'; script-src 'sha256-${PICKUP_SCRIPT_HASH}'; style-src 'unsafe-inline'; ` +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

module.exports = {
  CALLBACK_PATH,
  DELIVER_HOSTS,
  FRAGMENT_PATH,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  MAX_FRAGMENT_BYTES,
  PENDING_TTL_MS,
  PICKUP_SCRIPT,
  SECURITY_HEADERS,
  deliverable,
  fragmentPostAllowed,
  fromFragment,
  fromQuery,
  hostAllowed,
  newNonce,
  newPending,
  parsePost,
  pendingLive,
  pendingMatches,
  withCode,
  withFragment,
};
