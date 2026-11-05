const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  LOOPBACK_ORIGIN,
  MAX_FRAGMENT_BYTES,
  PENDING_TTL_MS,
  PICKUP_SCRIPT,
  FRAGMENT_PATH,
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
} = require('./callback');

const q = (s) => new URLSearchParams(s);

test('the query: a PKCE code, an error, or neither', () => {
  assert.deepStrictEqual(fromQuery(q('code=abc&s=N')), { kind: 'code', code: 'abc' });
  assert.deepStrictEqual(fromQuery(q('error=access_denied&error_description=User+cancelled')), {
    kind: 'error', message: 'User cancelled',
  });
  assert.deepStrictEqual(fromQuery(q('error=server_error')), { kind: 'error', message: 'server_error' });
  // backquant.com's implicit sign-in: nothing in the query, the session is in the fragment.
  assert.deepStrictEqual(fromQuery(q('s=N')), { kind: 'none' });
  assert.deepStrictEqual(fromQuery(q('code=')), { kind: 'none' });
});

test('an implicit session in the fragment is passed on, known keys only', () => {
  const got = fromFragment(
    '#access_token=AT&expires_at=1793790000&expires_in=3600&provider_token=PT' +
    '&refresh_token=RT&token_type=bearer&type=signup&junk=<script>',
  );
  assert.strictEqual(got.kind, 'session');
  const f = q(got.fragment);
  assert.strictEqual(f.get('access_token'), 'AT');
  assert.strictEqual(f.get('refresh_token'), 'RT');
  assert.strictEqual(f.get('expires_at'), '1793790000');
  assert.strictEqual(f.get('token_type'), 'bearer');
  assert.strictEqual(f.get('provider_token'), 'PT');
  assert.strictEqual(f.get('junk'), null);
});

test('a fragment without both tokens, too large, or not text is not a session', () => {
  assert.deepStrictEqual(fromFragment('access_token=AT'), { kind: 'none' });
  assert.deepStrictEqual(fromFragment('refresh_token=RT'), { kind: 'none' });
  assert.deepStrictEqual(fromFragment(''), { kind: 'none' });
  assert.deepStrictEqual(fromFragment(undefined), { kind: 'none' });
  assert.deepStrictEqual(fromFragment('access_token=AT&refresh_token=' + 'x'.repeat(MAX_FRAGMENT_BYTES)), { kind: 'none' });
});

test('an error in the fragment is shown', () => {
  assert.deepStrictEqual(
    fromFragment('error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance'),
    { kind: 'error', message: 'Signups not allowed for this instance' },
  );
});

test('only the code goes on the query of the original redirect_to, the session on its fragment', () => {
  assert.strictEqual(
    withCode('https://terminal.backquant.com/auth/redirect', 'abc'),
    'https://terminal.backquant.com/auth/redirect?code=abc',
  );
  assert.strictEqual(
    withFragment('https://www.backquant.com/auth/redirect?next=%2Fpro#old', 'access_token=AT&refresh_token=RT'),
    'https://www.backquant.com/auth/redirect?next=%2Fpro#access_token=AT&refresh_token=RT',
  );
});

test('each sign-in gets its own unguessable nonce', () => {
  const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
  assert.strictEqual(seen.size, 200);
  for (const n of seen) assert.match(n, /^[A-Za-z0-9_-]{32}$/);
});

test('only the waiting sign-in\'s own nonce matches, and only until it expires', () => {
  const t = 1_000_000;
  const p = newPending('https://www.backquant.com/auth/redirect', t);
  assert.ok(pendingMatches(p, p.nonce, t + 1000));
  assert.ok(!pendingMatches(p, newNonce(), t + 1000));                 // another nonce
  assert.ok(!pendingMatches(p, p.nonce.slice(0, -1), t + 1000));       // a prefix
  assert.ok(!pendingMatches(p, '', t + 1000));
  assert.ok(!pendingMatches(p, undefined, t + 1000));
  assert.ok(!pendingMatches(null, p.nonce, t + 1000));                  // nothing waiting
  assert.ok(pendingLive(p, t + PENDING_TTL_MS));
  assert.ok(!pendingLive(p, t + PENDING_TTL_MS + 1));
  assert.ok(!pendingMatches(p, p.nonce, t + PENDING_TTL_MS + 1));       // expired
});

test('forged-fragment race: a page that opens the loopback cannot win without the nonce', () => {
  // The attack: while a sign-in waits, another site opens
  // 127.0.0.1:47821/callback#access_token=ATK&refresh_token=ATK, again and again. Our
  // pickup page runs and posts from the loopback origin (so the Origin check passes),
  // but the nonce it sends is whatever the attacker put in the address: never ours.
  const p = newPending('https://www.backquant.com/auth/redirect');
  assert.ok(fragmentPostAllowed('POST', LOOPBACK_ORIGIN));
  for (let i = 0; i < 1000; i++) {
    const forged = parsePost(JSON.stringify({ s: i % 2 ? '' : newNonce(), fragment: 'access_token=ATK&refresh_token=ATK' }));
    assert.ok(!pendingMatches(p, forged.nonce));
  }
  const real = parsePost(JSON.stringify({ s: p.nonce, fragment: 'access_token=AT&refresh_token=RT' }));
  assert.ok(pendingMatches(p, real.nonce));
  assert.strictEqual(fromFragment(real.fragment).kind, 'session');
});

test('the fragment post body is { s, fragment } and nothing else', () => {
  assert.deepStrictEqual(parsePost('{"s":"N","fragment":"a=1"}'), { nonce: 'N', fragment: 'a=1' });
  assert.strictEqual(parsePost('access_token=AT&refresh_token=RT'), null);
  assert.strictEqual(parsePost('{"s":1,"fragment":"a"}'), null);
  assert.strictEqual(parsePost('{"fragment":"a"}'), null);
  assert.strictEqual(parsePost(''), null);
});

test('only our own callback page may post a fragment', () => {
  assert.ok(fragmentPostAllowed('POST', LOOPBACK_ORIGIN));
  assert.ok(!fragmentPostAllowed('POST', 'https://evil.example'));
  assert.ok(!fragmentPostAllowed('POST', 'null'));
  assert.ok(!fragmentPostAllowed('POST', undefined));
  assert.ok(!fragmentPostAllowed('GET', LOOPBACK_ORIGIN));
  assert.ok(!fragmentPostAllowed('POST', 'http://localhost:47821'));
});

test('only requests addressed to 127.0.0.1:47821 are served (DNS rebinding)', () => {
  assert.ok(hostAllowed('127.0.0.1:47821'));
  for (const h of ['localhost:47821', 'evil.example:47821', 'evil.example', '127.0.0.1', '127.0.0.1:80', undefined, '']) {
    assert.ok(!hostAllowed(h), String(h));
  }
});

test('the result is delivered only over https to backquant.com, www and the terminal', () => {
  for (const ok of [
    'https://www.backquant.com/auth/redirect#access_token=AT',
    'https://backquant.com/auth/redirect',
    'https://terminal.backquant.com/auth/redirect?code=abc',
  ]) assert.ok(deliverable(ok), ok);
  for (const bad of [
    'http://terminal.backquant.com/auth/redirect',       // plain http
    'https://github.com/x#access_token=AT',              // in-app, but not ours
    'https://checkout.stripe.com/x',
    'https://nowpayments.io/x',
    'https://evil.backquant.com/x',                      // another subdomain
    'https://backquant.com.evil.example/x',
    'https://user:pw@terminal.backquant.com/x',
    'https://terminal.backquant.com:8443/x',
    'https://evil.example/steal#access_token=AT',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ]) assert.ok(!deliverable(bad), bad);
});

test('the loopback pages cannot be framed, cached or run any script but the pickup', () => {
  assert.strictEqual(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.strictEqual(SECURITY_HEADERS['Cache-Control'], 'no-store');
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  const hash = crypto.createHash('sha256').update(PICKUP_SCRIPT).digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`));
});

test('the callback page posts its fragment with the nonce and clears both from the address', () => {
  assert.ok(PICKUP_SCRIPT.includes(JSON.stringify(FRAGMENT_PATH)));
  assert.ok(PICKUP_SCRIPT.includes("method: 'POST'"));
  assert.ok(PICKUP_SCRIPT.includes("get('s')"));
  assert.ok(PICKUP_SCRIPT.includes('history.replaceState'));
  assert.ok(PICKUP_SCRIPT.indexOf('history.replaceState') < PICKUP_SCRIPT.indexOf('if (!h) return'));
  assert.doesNotThrow(() => new Function(PICKUP_SCRIPT));
});
