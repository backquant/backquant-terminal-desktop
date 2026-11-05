const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  LOOPBACK_ORIGIN,
  MAX_FRAGMENT_BYTES,
  MAX_PENDING,
  PENDING_TTL_MS,
  PICKUP_SCRIPT,
  PendingSignIns,
  FRAGMENT_PATH,
  SECURITY_HEADERS,
  deliverable,
  fragmentPostAllowed,
  fromFragment,
  fromQuery,
  hostAllowed,
  newNonce,
  parsePost,
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

test('only a waiting sign-in\'s own nonce matches, and only until it expires', () => {
  const t = 1_000_000;
  const ps = new PendingSignIns();
  const n = newNonce();
  ps.add(n, 'https://www.backquant.com/auth/redirect', t);
  assert.strictEqual(ps.find(n, t + 1000).dest, 'https://www.backquant.com/auth/redirect');
  assert.strictEqual(ps.find(newNonce(), t + 1000), null);              // another nonce
  assert.strictEqual(ps.find(n.slice(0, -1), t + 1000), null);          // a prefix
  assert.strictEqual(ps.find('', t + 1000), null);
  assert.strictEqual(ps.find(undefined, t + 1000), null);
  assert.ok(ps.find(n, t + PENDING_TTL_MS));
  assert.strictEqual(ps.find(n, t + PENDING_TTL_MS + 1), null);         // expired
  assert.strictEqual(ps.size, 0);
});

test('a double click: both sign-ins wait, either may finish, at most MAX_PENDING', () => {
  const t = 2_000_000;
  const ps = new PendingSignIns();
  const a = newNonce(); const b = newNonce();
  ps.add(a, 'https://terminal.backquant.com/auth/redirect', t);
  ps.add(b, 'https://terminal.backquant.com/auth/redirect', t + 500);
  assert.ok(ps.find(a, t + 1000) && ps.find(b, t + 1000));
  ps.remove(a);                                                          // the first one failed
  assert.strictEqual(ps.find(a, t + 1000), null);
  assert.ok(ps.find(b, t + 1000));                                       // the other still waits
  ps.clear();                                                            // one finished
  assert.strictEqual(ps.size, 0);
  const many = Array.from({ length: MAX_PENDING + 2 }, (_, i) => { const x = newNonce(); ps.add(x, 'https://www.backquant.com/auth/redirect', t + i); return x; });
  assert.strictEqual(ps.size, MAX_PENDING);
  assert.strictEqual(ps.find(many[0], t + 10), null);                    // the oldest dropped
  assert.ok(ps.find(many[many.length - 1], t + 10));
  // Each keeps its own TTL.
  const ps2 = new PendingSignIns();
  const old = newNonce(); const young = newNonce();
  ps2.add(old, 'https://www.backquant.com/auth/redirect', t);
  ps2.add(young, 'https://www.backquant.com/auth/redirect', t + 60_000);
  assert.strictEqual(ps2.find(old, t + PENDING_TTL_MS + 1), null);
  assert.ok(ps2.find(young, t + PENDING_TTL_MS + 1));
});

test('forged-fragment race: a page that opens the loopback cannot win without a nonce', () => {
  // The attack: while a sign-in waits, another site opens
  // 127.0.0.1:47821/callback#access_token=ATK&refresh_token=ATK, again and again. Our
  // pickup page runs and posts from the loopback origin (so the Origin check passes),
  // but the nonce it sends is whatever the attacker put in the address: never ours.
  const ps = new PendingSignIns();
  const real = newNonce();
  ps.add(real, 'https://www.backquant.com/auth/redirect');
  assert.ok(fragmentPostAllowed('POST', LOOPBACK_ORIGIN));
  for (let i = 0; i < 1000; i++) {
    const forged = parsePost(JSON.stringify({ s: i % 2 ? '' : newNonce(), fragment: 'access_token=ATK&refresh_token=ATK' }));
    assert.strictEqual(ps.find(forged.nonce), null);
  }
  assert.ok(ps.find(real));
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

test('the result is delivered only over https to the sign-in return page of backquant.com, www and the terminal', () => {
  for (const ok of [
    'https://www.backquant.com/auth/redirect#access_token=AT',
    'https://backquant.com/auth/redirect',
    'https://terminal.backquant.com/auth/redirect?code=abc',
  ]) assert.ok(deliverable(ok), ok);
  for (const bad of [
    'http://terminal.backquant.com/auth/redirect',       // plain http
    'https://terminal.backquant.com/pro',                 // our host, not the return page
    'https://www.backquant.com/go?to=https://evil.example', // an open redirect elsewhere
    'https://www.backquant.com/auth/redirect/../x',
    'https://www.backquant.com/auth/redirectx',
    'https://github.com/auth/redirect#access_token=AT',  // in-app, but not ours
    'https://checkout.stripe.com/auth/redirect',
    'https://evil.backquant.com/auth/redirect',          // another subdomain
    'https://backquant.com.evil.example/auth/redirect',
    'https://user:pw@terminal.backquant.com/auth/redirect',
    'https://terminal.backquant.com:8443/auth/redirect',
    'https://evil.example/auth/redirect#access_token=AT',
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
