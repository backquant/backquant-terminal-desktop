const test = require('node:test');
const assert = require('node:assert');
const {
  LOOPBACK_ORIGIN,
  MAX_FRAGMENT_BYTES,
  PICKUP_SCRIPT,
  FRAGMENT_PATH,
  deliverable,
  fragmentPostAllowed,
  fromFragment,
  fromQuery,
  withFragment,
  withQuery,
} = require('./callback');

const q = (s) => new URLSearchParams(s);

test('the query: a PKCE code, an error, or neither', () => {
  assert.deepStrictEqual(fromQuery(q('code=abc')), { kind: 'code' });
  assert.deepStrictEqual(fromQuery(q('error=access_denied&error_description=User+cancelled')), {
    kind: 'error', message: 'User cancelled',
  });
  assert.deepStrictEqual(fromQuery(q('error=server_error')), { kind: 'error', message: 'server_error' });
  // backquant.com's implicit sign-in: nothing in the query, the session is in the fragment.
  assert.deepStrictEqual(fromQuery(q('')), { kind: 'none' });
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

test('the code goes on the query of the original redirect_to, the session on its fragment', () => {
  assert.strictEqual(
    withQuery('https://terminal.backquant.com/auth/redirect', q('code=abc')),
    'https://terminal.backquant.com/auth/redirect?code=abc',
  );
  assert.strictEqual(
    withFragment('https://backquant.com/auth/redirect?next=%2Fpro#old', 'access_token=AT&refresh_token=RT'),
    'https://backquant.com/auth/redirect?next=%2Fpro#access_token=AT&refresh_token=RT',
  );
});

test('only our own callback page may post a fragment', () => {
  assert.ok(fragmentPostAllowed('POST', LOOPBACK_ORIGIN));
  assert.ok(!fragmentPostAllowed('POST', 'https://evil.example'));
  assert.ok(!fragmentPostAllowed('POST', 'null'));
  assert.ok(!fragmentPostAllowed('POST', undefined));
  assert.ok(!fragmentPostAllowed('GET', LOOPBACK_ORIGIN));
  assert.ok(!fragmentPostAllowed('POST', 'http://localhost:47821'));
});

test('the result is delivered only to the app\'s own pages', () => {
  assert.ok(deliverable('https://backquant.com/auth/redirect#access_token=AT'));
  assert.ok(deliverable('https://terminal.backquant.com/auth/redirect?code=abc'));
  assert.ok(!deliverable('https://evil.example/steal#access_token=AT'));
  assert.ok(!deliverable('file:///etc/passwd'));
  assert.ok(!deliverable('javascript:alert(1)'));
  assert.ok(!deliverable('not a url'));
});

test('the callback page posts its fragment to the fragment path and clears it from the address', () => {
  assert.ok(PICKUP_SCRIPT.includes(JSON.stringify(FRAGMENT_PATH)));
  assert.ok(PICKUP_SCRIPT.includes("method: 'POST'"));
  assert.ok(PICKUP_SCRIPT.includes('history.replaceState'));
  assert.doesNotThrow(() => new Function(PICKUP_SCRIPT));
});
