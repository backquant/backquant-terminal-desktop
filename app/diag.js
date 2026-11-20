// Diagnostics. When the terminal freezes or a helper process dies, there was no trace of
// it: a crash reloaded the page and a freeze just sat there. Now the app keeps a small log
// (app.log in the app's logs folder): page freezes and how long they lasted, crashed
// processes (the page, the GPU process, utilities) with their reason and exit code, the GPU
// setup at start, and memory and CPU per process type every few minutes. Help > Save
// Diagnostics writes it, with the versions and the GPU details, to one file to send us.

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** One log line: an ISO time, then the event and its details as JSON. */
function logLine(event, details, now = new Date()) {
  const body = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  return `${now.toISOString()} ${event}${body}\n`;
}

/**
 * Memory and CPU per process type, from app.getAppMetrics(): the total working set in MB,
 * how many processes, and their summed CPU percent, by type (Browser, Tab, GPU, Utility...).
 */
function summarizeMetrics(metrics) {
  const out = {};
  for (const each of metrics) {
    const type = each.type || 'Unknown';
    const row = out[type] || (out[type] = { count: 0, mb: 0, cpu: 0 });
    row.count += 1;
    row.mb += Math.round(((each.memory && each.memory.workingSetSize) || 0) / 1024);
    row.cpu += Math.round(((each.cpu && each.cpu.percentCPUUsage) || 0) * 10) / 10;
  }
  for (const row of Object.values(out)) row.cpu = Math.round(row.cpu * 10) / 10;
  return out;
}

/** How long a freeze lasted, as said in the log and the notice: "12 s", "2 min 5 s". */
function durationText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The log, appended to; when it passes MAX_LOG_BYTES the older half is moved to app.old.log. */
class DiagLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'app.log');
    this.old = path.join(dir, 'app.old.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // No logs folder: the log is skipped, the app runs as before.
    }
  }

  write(event, details) {
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size > MAX_LOG_BYTES) fs.renameSync(this.file, this.old);
      fs.appendFileSync(this.file, logLine(event, details));
    } catch {
      // A full disk or a locked file never stops the app.
    }
  }

  /** Both logs, older first, for a diagnostics file. */
  read() {
    const part = (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    };
    return part(this.old) + part(this.file);
  }
}

module.exports = { DiagLog, MAX_LOG_BYTES, durationText, logLine, summarizeMetrics };
