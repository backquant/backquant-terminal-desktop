// URL rules for the shell, kept apart from Electron so they can be unit tested.

const HOME_URL = 'https://terminal.backquant.com/pro';
const DOCS_URL = 'https://backquant.com/documentation';

// OAuth sign-in returns here: the sign-in provider sends the browser back to this
// local address, and the app hands the result to its window.
const LOOPBACK_PORT = 47821;
const LOOPBACK_CALLBACK = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

const IN_APP_DOMAINS = [
  'backquant.com',
  'github.com',
  'discord.com',
  'stripe.com',
  'stripe.network',
  'nowpayments.io',
];

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Pages allowed to replace the terminal in the main window: our own sites plus the
 *  sign-in and payment providers the account flows pass through. Anything else the
 *  main window lands on is handed to the default browser. */
function allowedInApp(url) {
  const u = parse(url);
  if (!u) return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  return IN_APP_DOMAINS.some((d) => hostMatches(u.hostname, d));
}

// Our Supabase auth host: only its authorize requests are sent to the browser with
// the loopback as redirect_to.
const AUTH_HOST = 'auth.backquant.com';

/** OAuth authorize request on our auth host, e.g.
 *  https://auth.backquant.com/auth/v1/authorize?provider=google&redirect_to=... */
function isOAuthAuthorize(url) {
  const u = parse(url);
  return !!u && u.protocol === 'https:' && u.hostname === AUTH_HOST
    && u.pathname === '/auth/v1/authorize' && u.searchParams.has('provider');
}

/** Swap redirect_to for the loopback callback carrying this sign-in's nonce (`s`),
 *  keeping every other parameter (notably the PKCE code_challenge, whose verifier
 *  lives in this window's storage). Supabase returns to exactly that address, so
 *  only the browser that ran this sign-in knows the nonce (see callback.js).
 *  Returns the browser URL and the original redirect_to (or null). */
function rewriteRedirect(url, nonce) {
  const u = new URL(url);
  const original = u.searchParams.get('redirect_to');
  const back = new URL(LOOPBACK_CALLBACK);
  back.searchParams.set('s', nonce);
  u.searchParams.set('redirect_to', back.toString());
  return { browserUrl: u.toString(), original: original && parse(original) ? original : null };
}

module.exports = {
  AUTH_HOST,
  HOME_URL,
  DOCS_URL,
  LOOPBACK_PORT,
  LOOPBACK_CALLBACK,
  allowedInApp,
  isOAuthAuthorize,
  rewriteRedirect,
};
