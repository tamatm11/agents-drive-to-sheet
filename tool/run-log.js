const fs = require('fs');
const path = require('path');

const RUN_LOGS_DIR = path.join(__dirname, 'run-logs');

function ensureRunLogDir() {
  if (!fs.existsSync(RUN_LOGS_DIR)) fs.mkdirSync(RUN_LOGS_DIR, { recursive: true });
}

function safeRunId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function newRunId(prefix = 'sync') {
  return safeRunId(`${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

function pairKey(pair) {
  return `${pair.gv_folder_id}|${pair.sheet_id}`;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function completedPairsForRun(runId) {
  ensureRunLogDir();
  const file = path.join(RUN_LOGS_DIR, `${safeRunId(runId)}.jsonl`);
  const done = new Set();
  for (const event of readJsonl(file)) {
    if (event.event === 'pair-finish' && event.status === 'ok' && event.pairKey) {
      done.add(event.pairKey);
    }
  }
  return done;
}

function createRunLogger(meta = {}) {
  ensureRunLogDir();
  const runId = safeRunId(meta.runId) || newRunId(meta.mode || 'sync');
  const logPath = path.join(RUN_LOGS_DIR, `${runId}.jsonl`);
  const startedAt = new Date().toISOString();

  function write(event, payload = {}) {
    const row = { ts: new Date().toISOString(), runId, event, ...payload };
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
    return row;
  }

  function finish(summary) {
    const endedAt = new Date().toISOString();
    write('run-finish', { startedAt, endedAt, summary });
    fs.writeFileSync(
      path.join(RUN_LOGS_DIR, 'latest.json'),
      JSON.stringify({ runId, logPath, startedAt, endedAt, summary }, null, 2),
    );
  }

  write('run-start', { startedAt, meta });
  return { runId, logPath, write, finish };
}

module.exports = {
  RUN_LOGS_DIR,
  createRunLogger,
  completedPairsForRun,
  pairKey,
  safeRunId,
};
