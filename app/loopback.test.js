// The loopback receiver as a real HTTP server (plain Node, a free port): what each
// request does to the waiting sign-ins and what reaches the window.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PendingSignIns, createHandler, newNonce } = require('./callback');

async function server() {
  const pendings = new PendingSignIns();
  const delivered = [];
  const failures = [];
  let port = 0;
  const handler = (req, res) => createHandler({
    pendings, port, onDeliver: (u) => delivered.push(u), onFailed: (m) => failures.push(m),
  })(req, res);
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  const host = `127.0.0.1:${port}`;
  const req = (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (body) r.write(body);
    r.end();
  });
  const post = (s, fragment, origin = `http://${host}`) => req('/callback/fragment', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify({ s, fragment }),
  });
  const start = (dest = 'https://www.backquant.com/auth/redirect') => { const n = newNonce(); pendings.add(n, dest); return n; };
  return { srv, pendings, delivered, failures, req, post, start, host };
}

const title = (r) => (r.body.match(/<h1>([^<]*)<\/h1>/) || [])[1] || (r.body.startsWith('{') ? JSON.parse(r.body).title : '');

test('implicit: the page with the nonce, then its fragment post, delivers the session', async () => {
  const s = await server();
  const n = s.start();
  const page = await s.req(`/callback?s=${n}`);
  assert.strictEqual(title(page), 'Sign-in incomplete');               // until the page posts its fragment
  assert.ok(page.body.includes('<script>'));
  assert.strictEqual(s.pendings.size, 1);
  const r = await s.post(n, 'access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer&junk=1');
  assert.strictEqual(title(r), 'Signed in');
  assert.deepStrictEqual(s.delivered, ['https://www.backquant.com/auth/redirect#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer']);
  assert.strictEqual(s.pendings.size, 0);
  assert.strictEqual(title(await s.post(n, 'access_token=AT2&refresh_token=RT2')), 'No sign-in in progress');   // no replay
  s.srv.close();
});

test('pkce: only the code goes to the terminal\'s return page', async () => {
  const s = await server();
  const n = s.start('https://terminal.backquant.com/auth/redirect');
  const r = await s.req(`/callback?s=${n}&code=C0DE&extra=x`);
  assert.strictEqual(title(r), 'Signed in');
  assert.deepStrictEqual(s.delivered, ['https://terminal.backquant.com/auth/redirect?code=C0DE']);
  s.srv.close();
});

test('a double click: the first tab to finish signs in, then the other is over', async () => {
  const s = await server();
  const a = s.start('https://terminal.backquant.com/auth/redirect');
  const b = s.start('https://terminal.backquant.com/auth/redirect');
  assert.strictEqual(title(await s.req(`/callback?s=${a}&code=FIRST`)), 'Signed in');
  assert.deepStrictEqual(s.delivered, ['https://terminal.backquant.com/auth/redirect?code=FIRST']);
  assert.strictEqual(title(await s.req(`/callback?s=${b}&code=SECOND`)), 'No sign-in in progress');
  // ... and the other order: the second tab finishes first.
  const s2 = await server();
  const c = s2.start('https://terminal.backquant.com/auth/redirect');
  const d = s2.start('https://terminal.backquant.com/auth/redirect');
  assert.strictEqual(title(await s2.req(`/callback?s=${d}&code=SECOND`)), 'Signed in');
  assert.strictEqual(title(await s2.req(`/callback?s=${c}&code=FIRST`)), 'No sign-in in progress');
  s.srv.close(); s2.srv.close();
});

test('a refused tab ends only itself: the other still finishes', async () => {
  const s = await server();
  const a = s.start(); const b = s.start();
  const r = await s.req(`/callback?s=${a}&error=access_denied&error_description=User+cancelled`);
  assert.strictEqual(title(r), 'Sign-in failed');
  assert.deepStrictEqual(s.failures, ['User cancelled']);
  assert.strictEqual(title(await s.post(b, 'access_token=AT&refresh_token=RT')), 'Signed in');
  assert.strictEqual(s.delivered.length, 1);
  s.srv.close();
});

test('an error in the fragment fails that sign-in and says why', async () => {
  const s = await server();
  const n = s.start();
  const r = await s.post(n, 'error=access_denied&error_description=Signups+not+allowed+for+this+instance');
  assert.strictEqual(title(r), 'Sign-in failed');
  assert.deepStrictEqual(s.failures, ['Signups not allowed for this instance']);
  assert.strictEqual(s.pendings.size, 0);
  s.srv.close();
});

test('login CSRF: forged hand-backs without the nonce change nothing', async () => {
  const s = await server();
  const n = s.start();
  for (const path of [
    '/callback', '/callback?s=', '/callback?s=guess', `/callback?s=${newNonce()}`,
    '/callback?code=ATK', '/callback?error=access_denied&error_description=ATTACKER+TEXT',
    `/callback?s=${n.slice(0, -1)}&code=ATK`,
  ]) {
    const r = await s.req(path);
    assert.strictEqual(title(r), 'No sign-in in progress', path);
  }
  for (const nonce of ['', 'guess', newNonce(), n.toUpperCase() === n ? `${n}x` : n.toUpperCase()]) {
    const r = await s.post(nonce, 'access_token=ATK&refresh_token=ATK');
    assert.strictEqual(title(r), 'No sign-in in progress');
  }
  const foreign = await s.post(n, 'access_token=ATK&refresh_token=ATK', 'https://evil.example');
  assert.strictEqual(foreign.status, 403);
  assert.deepStrictEqual(s.delivered, []);
  assert.deepStrictEqual(s.failures, []);
  assert.strictEqual(s.pendings.size, 1);                                 // the real one still waits
  assert.strictEqual(title(await s.post(n, 'access_token=REAL&refresh_token=REAL')), 'Signed in');
  assert.ok(s.delivered[0].includes('access_token=REAL'));
  s.srv.close();
});

test('a redirect_to that is not a sign-in return page is never handed the session', async () => {
  const s = await server();
  const n = s.start('https://www.backquant.com/go?to=https://evil.example');
  assert.strictEqual(title(await s.post(n, 'access_token=AT&refresh_token=RT')), 'Signed in');
  assert.deepStrictEqual(s.delivered, [null]);                            // the app opens home instead
  s.srv.close();
});

test('requests addressed to another host name get nothing (DNS rebinding)', async () => {
  const s = await server();
  const n = s.start();
  for (const h of ['evil.example', 'localhost', `localhost:${s.host.split(':')[1]}`]) {
    const r = await s.req(`/callback?s=${n}&code=X`, { headers: { Host: h } });
    assert.strictEqual(r.status, 421, h);
  }
  assert.strictEqual(s.pendings.size, 1);
  s.srv.close();
});

test('every answer carries the no-frame, no-cache, script-pinned headers', async () => {
  const s = await server();
  for (const r of [await s.req('/callback'), await s.req('/nope'), await s.post('x', 'y')]) {
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  s.srv.close();
});

test('size, method and path limits', async () => {
  const s = await server();
  const n = s.start();
  const big = await s.req('/callback/fragment', {
    method: 'POST', headers: { Origin: `http://${s.host}`, 'Content-Type': 'text/plain' }, body: 'x'.repeat(40 * 1024),
  });
  assert.strictEqual(big.status, 413);
  assert.strictEqual((await s.req(`/callback?s=${n}`, { method: 'POST' })).status, 405);
  assert.strictEqual((await s.req('/callback/fragment')).status, 403);  // GET
  assert.strictEqual((await s.req('/elsewhere')).status, 404);
  assert.strictEqual(s.pendings.size, 1);
  s.srv.close();
});
