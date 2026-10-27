const test = require('node:test');
const assert = require('node:assert');
const { CRASH_WINDOW_MS, MAX_RELOADS, afterCrash } = require('./crash');

test('a normal exit is not a crash', () => {
  assert.deepStrictEqual(afterCrash('clean-exit', [1, 2], 3), { action: 'ignore', recent: [1, 2] });
});

test('reloads after a crash, out of memory or a kill', () => {
  for (const reason of ['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed']) {
    assert.deepStrictEqual(afterCrash(reason, [], 1000), { action: 'reload', recent: [1000] });
  }
});

test('stops reloading on the fourth crash within two minutes', () => {
  let recent = [];
  const actions = [];
  for (let i = 0; i <= MAX_RELOADS; i++) {
    const out = afterCrash('crashed', recent, 1000 + i * 1000);
    actions.push(out.action);
    recent = out.recent;
  }
  assert.deepStrictEqual(actions, ['reload', 'reload', 'reload', 'stop']);
});

test('crashes older than two minutes do not count', () => {
  const now = 10 * CRASH_WINDOW_MS;
  const old = [now - CRASH_WINDOW_MS - 3, now - CRASH_WINDOW_MS - 2, now - CRASH_WINDOW_MS - 1];
  assert.deepStrictEqual(afterCrash('oom', old, now), { action: 'reload', recent: [now] });
});
