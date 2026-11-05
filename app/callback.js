// The loopback receiver for a sign-in that comes back from the browser, kept apart from
// Electron so it can be tested with plain Node (callback.test.js, loopback.test.js).
//
// A sign-in comes back in one of two shapes:
//   * PKCE (the terminal's own sign-in): `?code=...` in the query, which the
//     receiver sees and hands to the original redirect_to.
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
// require it. A wrong nonce changes nothing. Up to MAX_PENDING sign-ins wait at once
// (a double click opens two browser tabs; either may finish), each for PENDING_TTL_MS.

const crypto = require('node:crypto');
const { LOOPBACK_PORT } = require('./urls');

const LOOPBACK_HOST = `127.0.0.1:${LOOPBACK_PORT}`;
const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}`;
const CALLBACK_PATH = '/callback';
const FRAGMENT_PATH = '/callback/fragment';
// A sign-in left waiting longer than this is dropped (a browser tab left open, an
// abandoned provider page).
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 3;
// A session fragment is a few KB (two tokens and the provider's); anything far
// larger is not one.
const MAX_FRAGMENT_BYTES = 32 * 1024;
// The fragment keys a Supabase implicit sign-in carries. Only these are passed on.
const SESSION_KEYS = [
  'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type',
  'provider_token', 'provider_refresh_token', 'type',
];
// The only places a sign-in result is delivered to, over https: the sign-in return
// page of the website (served on www; the bare domain redirects there) and of the
// terminal. Both pass `${location.origin}/auth/redirect` as redirectTo (bq-web
// AuthContext, terminal lib/loginAuth.ts). A pinned path means an open redirect
// elsewhere on these hosts cannot carry the session on.
const DELIVER_HOSTS = new Set(['www.backquant.com', 'backquant.com', 'terminal.backquant.com']);
const DELIVER_PATHS = new Set(['/auth/redirect']);

const SIGNED_IN = ['Signed in', 'You can close this tab and return to BackQuant Terminal.'];
const NO_SIGN_IN = ['No sign-in in progress', 'Open BackQuant Terminal and sign in again.'];
const INCOMPLETE = ['Sign-in incomplete', 'Return to BackQuant Terminal and try again.'];
const failed = (message) => ['Sign-in failed', `${message}. Return to BackQuant Terminal and try again.`];

/** A fresh nonce for one sign-in: 192 random bits, URL-safe. */
function newNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function sameNonce(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The sign-ins waiting for their result: at most MAX_PENDING, each until its TTL. */
class PendingSignIns {
  constructor({ ttlMs = PENDING_TTL_MS, max = MAX_PENDING } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = [];          // { nonce, dest, at }, oldest first
  }

  prune(now = Date.now()) {
    this.items = this.items.filter((p) => now - p.at <= this.ttlMs);
  }

  /** A new sign-in to `dest` under `nonce`; the oldest is dropped past `max`. */
  add(nonce, dest, now = Date.now()) {
    this.prune(now);
    this.items.push({ nonce, dest, at: now });
    while (this.items.length > this.max) this.items.shift();
  }

  /** The waiting sign-in with this nonce (constant-time compare), or null. */
  find(nonce, now = Date.now()) {
    this.prune(now);
    if (typeof nonce !== 'string' || !nonce) return null;
    let hit = null;
    for (const p of this.items) if (sameNonce(p.nonce, nonce)) hit = p;
    return hit;
  }

  /** This sign-in is over (it failed): the others keep waiting. */
  remove(nonce) {
    this.items = this.items.filter((p) => p.nonce !== nonce);
  }

  /** A sign-in finished: none of the others is wanted any more. */
  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}

/** Only requests addressed to the loopback by its own name are served: a page on
 *  another name that resolves here (DNS rebinding) gets nothing. */
function hostAllowed(host, port = LOOPBACK_PORT) {
  return host === `127.0.0.1:${port}`;
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
function fragmentPostAllowed(method, origin, port = LOOPBACK_PORT) {
  return method === 'POST' && origin === `http://127.0.0.1:${port}`;
}

/** The redirect_to the window may be sent to: https, one of DELIVER_HOSTS, and one of
 *  DELIVER_PATHS exactly. */
function deliverable(dest) {
  try {
    const u = new URL(dest);
    return u.protocol === 'https:' && DELIVER_HOSTS.has(u.hostname) && DELIVER_PATHS.has(u.pathname)
      && !u.username && !u.password && !u.port;
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, body, script = '') {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>BackQuant Terminal</title><style>' +
    'html,body{margin:0;height:100%;background:#0b0b0c;color:#e8e8ea;' +
    'font:14px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
    'main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}' +
    'h1{font-size:16px;font-weight:600;margin:0}p{margin:0;color:#8a8a90}' +
    `</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>` +
    (script ? `<script>${script}</script>` : '') +
    '</body></html>'
  );
}

/** The request body as text, or null past `limit` bytes (the rest is not read; the
 *  caller answers and the connection is closed after the answer). */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData);
        req.pause();
        resolve(null);
      } else {
        parts.push(c);
      }
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** The loopback's request handler. `onDeliver(url)` opens a finished sign-in in the
 *  window (url is already checked deliverable, or null when the redirect_to was not);
 *  `onFailed(message)` reports a sign-in the provider refused. */
function createHandler({ pendings, onDeliver, onFailed, port = LOOPBACK_PORT }) {
  const origin = `http://127.0.0.1:${port}`;
  const deliver = (url) => onDeliver(deliverable(url) ? url : null);
  return async (req, res) => {
    const send = (status, [title, body = ''], script = '') => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(title, body, script));
    };
    const answer = (status, [title, body = ''], close = false) => {
      res.writeHead(status, {
        ...SECURITY_HEADERS, 'Content-Type': 'application/json', ...(close ? { Connection: 'close' } : {}),
      });
      res.end(JSON.stringify({ title, body }));
      if (close) res.on('finish', () => req.destroy());
    };
    // Addressed to the loopback by its own name only (DNS rebinding gets nothing).
    if (!hostAllowed(req.headers.host, port)) {
      res.writeHead(421, SECURITY_HEADERS);
      return res.end();
    }
    const cb = new URL(req.url || '/', origin);

    // The callback page posting its fragment back (an implicit sign-in).
    if (cb.pathname === FRAGMENT_PATH) {
      if (!fragmentPostAllowed(req.method, req.headers.origin, port)) return answer(403, ['Not allowed']);
      const text = await readBody(req, MAX_FRAGMENT_BYTES);
      if (text == null) return answer(413, INCOMPLETE, true);
      const post = parsePost(text);
      const p = post && pendings.find(post.nonce);
      // Not a waiting sign-in's nonce: nothing is delivered, nothing is cancelled.
      if (!p) return answer(200, NO_SIGN_IN);
      const got = fromFragment(post.fragment);
      if (got.kind === 'none') return answer(200, INCOMPLETE);
      if (got.kind === 'error') {
        pendings.remove(p.nonce);
        answer(200, failed(got.message));
        return onFailed(got.message);
      }
      pendings.clear();
      answer(200, SIGNED_IN);
      return deliver(withFragment(p.dest, got.fragment));
    }

    if (cb.pathname !== CALLBACK_PATH) return send(404, ['Not found']);
    if (req.method !== 'GET') return send(405, ['Not allowed']);
    const p = pendings.find(cb.searchParams.get('s'));
    // Not a waiting sign-in's nonce: nothing is cancelled or delivered. (The page still
    // clears any fragment from the address.)
    if (!p) return send(200, NO_SIGN_IN, PICKUP_SCRIPT);
    const got = fromQuery(cb.searchParams);
    // Nothing in the query: the result may be in the fragment, which only the page can
    // read. The sign-in keeps waiting for it.
    if (got.kind === 'none') return send(200, INCOMPLETE, PICKUP_SCRIPT);
    if (got.kind === 'error') {
      pendings.remove(p.nonce);
      send(200, failed(got.message));
      return onFailed(got.message);
    }
    pendings.clear();
    send(200, SIGNED_IN);
    return deliver(withCode(p.dest, got.code));
  };
}

module.exports = {
  CALLBACK_PATH,
  DELIVER_HOSTS,
  DELIVER_PATHS,
  FRAGMENT_PATH,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  MAX_FRAGMENT_BYTES,
  MAX_PENDING,
  PENDING_TTL_MS,
  PICKUP_SCRIPT,
  PendingSignIns,
  SECURITY_HEADERS,
  createHandler,
  deliverable,
  fragmentPostAllowed,
  fromFragment,
  fromQuery,
  hostAllowed,
  newNonce,
  parsePost,
  withCode,
  withFragment,
};
