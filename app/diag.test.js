const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiagLog, MAX_LOG_BYTES, durationText, logLine, summarizeMetrics } = require('./diag');

test('a log line is the time, the event and its details', () => {
  assert.strictEqual(logLine('page-unresponsive', { url: 'x' }, new Date('2026-11-20T10:00:00Z')), '2026-11-20T10:00:00.000Z page-unresponsive {"url":"x"}\n');
  assert.strictEqual(logLine('app-quit', undefined, new Date('2026-11-20T10:00:00Z')), '2026-11-20T10:00:00.000Z app-quit\n');
});

test('memory and CPU are summed by process type', () => {
  const out = summarizeMetrics([
    { type: 'Tab', memory: { workingSetSize: 512 * 1024 }, cpu: { percentCPUUsage: 12.34 } },
    { type: 'Tab', memory: { workingSetSize: 256 * 1024 }, cpu: { percentCPUUsage: 1 } },
    { type: 'GPU', memory: { workingSetSize: 128 * 1024 }, cpu: { percentCPUUsage: 3 } },
    { type: 'Utility' },
  ]);
  assert.deepStrictEqual(out.Tab, { count: 2, mb: 768, cpu: 13.3 });
  assert.deepStrictEqual(out.GPU, { count: 1, mb: 128, cpu: 3 });
  assert.deepStrictEqual(out.Utility, { count: 1, mb: 0, cpu: 0 });
});

test('a freeze is said in seconds, then minutes', () => {
  assert.strictEqual(durationText(12_400), '12 s');
  assert.strictEqual(durationText(125_000), '2 min 5 s');
});

test('the log rolls over to app.old.log past its size, and reads back oldest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const log = new DiagLog(dir);
  fs.writeFileSync(path.join(dir, 'app.log'), 'x'.repeat(MAX_LOG_BYTES + 1));
  log.write('after-roll', { n: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'app.old.log')));
  const text = log.read();
  assert.ok(text.startsWith('xxx'));
  assert.ok(text.trimEnd().endsWith('after-roll {"n":1}'));
});
