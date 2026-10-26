const test = require('node:test');
const assert = require('node:assert');
const { allowedInApp, isOAuthAuthorize, rewriteRedirect, LOOPBACK_CALLBACK } = require('./urls');

test('oauth authorize is detected and rewritten', () => {
  const u =
    'https://auth.backquant.com/auth/v1/authorize?provider=google' +
    '&redirect_to=https%3A%2F%2Fterminal.backquant.com%2Fauth%2Fredirect' +
    '&code_challenge=abc&code_challenge_method=s256';
  assert.ok(isOAuthAuthorize(u));
  const { browserUrl, original } = rewriteRedirect(u);
  assert.strictEqual(original, 'https://terminal.backquant.com/auth/redirect');
  const q = new URL(browserUrl).searchParams;
  assert.strictEqual(q.get('redirect_to'), LOOPBACK_CALLBACK);
  assert.strictEqual(q.get('code_challenge'), 'abc');
  assert.strictEqual(q.get('provider'), 'google');
});

test('every provider goes through the browser', () => {
  for (const p of ['google', 'github', 'discord']) {
    assert.ok(isOAuthAuthorize(`https://auth.backquant.com/auth/v1/authorize?provider=${p}`), p);
  }
  assert.ok(!isOAuthAuthorize('https://auth.backquant.com/auth/v1/token?grant_type=pkce'));
});

test('in-app hosts', () => {
  for (const ok of [
    'https://terminal.backquant.com/pro',
    'https://backquant.com/checkout',
    'https://www.backquant.com/pricing',
    'https://checkout.stripe.com/x',
    'https://billing.stripe.com/p/session',
    'https://github.com/login/oauth/authorize',
    'https://discord.com/oauth2/authorize',
    'https://nowpayments.io/payment',
    'file:///Applications/x/index.html',
    'about:blank',
  ]) {
    assert.ok(allowedInApp(ok), ok);
  }
  for (const ext of [
    'https://x.com/intent/tweet',
    'https://notbackquant.com/',
    'https://backquant.com.evil.io/',
    'https://accounts.google.com/o/oauth2/v2/auth',
  ]) {
    assert.ok(!allowedInApp(ext), ext);
  }
});
