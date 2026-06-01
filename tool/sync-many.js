#!/usr/bin/env node
// Run render.js with the same sync logic across many teacher spreadsheets.
// Default mode is preview/list-changes; use --sync to write.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRunLogger, completedPairsForRun, pairKey } = require('./run-log');
const { getClients } = require('./auth');
const { backupSpreadsheet } = require('./backup');

const TOOL_DIR = __dirname;
const DEFAULT_PAIRS = path.join(TOOL_DIR, '..', '..', 'mcp-servers', 'gdrive-mcp', 'crawl-output', 'all-pairs.json');

function parseArgs(argv) {
  const out = {
    pairs: DEFAULT_PAIRS,
    mode: 'list',
    subject: '',
    teacher: '',
    limit: 0,
    includeNested: false,
    forceRefresh: false,
    noAutoRefresh: false,
    continueOnError: true,
    runId: '',
    resumeRunId: '',
    jsonSummary: false,
    backup: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pairs') out.pairs = argv[++i];
    else if (a === '--subject') out.subject = String(argv[++i] || '').toLowerCase();
    else if (a === '--teacher') out.teacher = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--include-nested') out.includeNested = true;
    else if (a === '--sync') out.mode = 'sync';
    else if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--list-changes') out.mode = 'list';
    else if (a === '--force-refresh') out.forceRefresh = true;
    else if (a === '--no-auto-refresh') out.noAutoRefresh = true;
    else if (a === '--stop-on-error') out.continueOnError = false;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--resume') out.resumeRunId = argv[++i];
    else if (a === '--json-summary') out.jsonSummary = true;
    else if (a === '--no-backup') out.backup = false;
    else if (a === '--backup') out.backup = true;
  }
  return out;
}

function existsJson(dir, id) {
  return fs.existsSync(path.join(TOOL_DIR, dir, `${id}.json`));
}

function loadPairs(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const excluded = new Set((payload.meta && payload.meta.excluded_sheets) || []);
  return (payload.pairs || []).filter((p) => p.gv_folder_id && p.sheet_id && !excluded.has(p.sheet_id));
}

function selectPairs(pairs, args) {
  const seen = new Set();
  const selected = [];
  for (const p of pairs) {
    if (!args.includeNested && p.parent_folder_id && p.parent_folder_id !== p.gv_folder_id) continue;
    if (args.teacher && p.gv_folder_id !== args.teacher) continue;
    if (args.subject && !String(p.subject_name || '').toLowerCase().includes(args.subject)) continue;
    const key = `${p.gv_folder_id}|${p.sheet_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(p);
    if (args.limit && selected.length >= args.limit) break;
  }
  return selected;
}

function commandForPair(pair, args) {
  const cmd = [process.execPath, path.join(TOOL_DIR, 'render.js'), '--teacher', pair.gv_folder_id, '--sheet', pair.sheet_id];
  if (args.mode === 'sync') cmd.push('--sync');
  else if (args.mode === 'dry-run') cmd.push('--dry-run');
  else cmd.push('--list-changes');
  if (args.forceRefresh) cmd.push('--force-refresh');
  if (args.noAutoRefresh) cmd.push('--no-auto-refresh');
  if (args.runId || args.resumeRunId) cmd.push('--run-id', args.runId || args.resumeRunId);
  if (args.jsonSummary) cmd.push('--json-summary');
  return cmd;
}

function extractJsonSummary(output) {
  const lines = String(output || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('JSON_SUMMARY ')) continue;
    try { return JSON.parse(line.slice('JSON_SUMMARY '.length)); }
    catch (_) { return null; }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.resumeRunId && !args.runId) args.runId = args.resumeRunId;
  const logger = createRunLogger({
    runId: args.runId,
    mode: args.mode,
    pairs: args.pairs,
    subject: args.subject,
    teacher: args.teacher,
    limit: args.limit,
    resumeRunId: args.resumeRunId,
  });
  const completed = args.resumeRunId ? completedPairsForRun(args.resumeRunId) : new Set();
  const pairs = selectPairs(loadPairs(args.pairs), args);
  const ready = [];
  const skipped = [];

  for (const p of pairs) {
    const hasTree = existsJson('trees', p.gv_folder_id);
    const hasSchema = existsJson('schemas', p.gv_folder_id);
    if (!hasTree || !hasSchema) {
      skipped.push({ pair: p, reason: `${hasTree ? '' : 'missing tree'}${!hasTree && !hasSchema ? ', ' : ''}${hasSchema ? '' : 'missing schema'}` });
      logger.write('pair-skip', { pairKey: pairKey(p), teacher: p.gv_name || p.gv_folder_id, sheetId: p.sheet_id, reason: `${hasTree ? '' : 'missing tree'}${!hasTree && !hasSchema ? ', ' : ''}${hasSchema ? '' : 'missing schema'}` });
      continue;
    }
    if (completed.has(pairKey(p))) {
      skipped.push({ pair: p, reason: `resume: already ok in ${args.resumeRunId}` });
      logger.write('pair-skip', { pairKey: pairKey(p), teacher: p.gv_name || p.gv_folder_id, sheetId: p.sheet_id, reason: `resume: already ok in ${args.resumeRunId}` });
      continue;
    }
    ready.push(p);
  }

  console.log(`Mode: ${args.mode} | ready ${ready.length}/${pairs.length} | skipped ${skipped.length}`);
  console.log(`Run log: ${logger.logPath}`);
  if (args.mode === 'sync' && args.backup && ready.length) {
    console.log('Backups: enabled (one Drive copy per unique spreadsheet before write). Use --no-backup to skip.');
  }
  skipped.slice(0, 20).forEach((s) => console.log(`  skip ${s.pair.gv_name || s.pair.gv_folder_id}: ${s.reason}`));
  if (skipped.length > 20) console.log(`  ... ${skipped.length - 20} more skipped`);

  let ok = 0;
  let failed = 0;
  const backups = new Map();
  let drive = null;
  for (let i = 0; i < ready.length; i++) {
    const p = ready[i];
    const cmd = commandForPair(p, args);
    console.log(`\n[${i + 1}/${ready.length}] ${p.gv_name || p.gv_folder_id}`);
    console.log(`  Sheet: ${p.sheet_id}`);
    const started = Date.now();
    logger.write('pair-start', { pairKey: pairKey(p), index: i + 1, total: ready.length, teacher: p.gv_name || p.gv_folder_id, teacherId: p.gv_folder_id, sheetId: p.sheet_id });
    if (args.mode === 'sync' && args.backup) {
      try {
        if (!backups.has(p.sheet_id)) {
          if (!drive) ({ drive } = await getClients());
          const backup = await backupSpreadsheet(drive, p.sheet_id, { runId: logger.runId });
          backups.set(p.sheet_id, backup);
          logger.write('backup-created', { pairKey: pairKey(p), teacherId: p.gv_folder_id, sheetId: p.sheet_id, ...backup });
          console.log(`  Backup: ${backup.backupName} (${backup.backupId})`);
        } else {
          const backup = backups.get(p.sheet_id);
          logger.write('backup-reused', { pairKey: pairKey(p), teacherId: p.gv_folder_id, sheetId: p.sheet_id, backupId: backup.backupId });
          console.log(`  Backup: reused ${backup.backupId}`);
        }
      } catch (err) {
        failed++;
        const durationMs = Date.now() - started;
        logger.write('pair-finish', { pairKey: pairKey(p), status: 'backup-failed', exitCode: 1, durationMs, error: err.message });
        console.error(`  Backup failed: ${err.message}`);
        if (!args.continueOnError) {
          logger.finish({ mode: args.mode, total: pairs.length, ready: ready.length, ok, failed, skipped: skipped.length, backups: backups.size, stoppedAtPair: i + 1 });
          process.exit(1);
        }
        continue;
      }
    }
    const res = spawnSync(cmd[0], cmd.slice(1), {
      cwd: TOOL_DIR,
      stdio: args.jsonSummary ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
      encoding: args.jsonSummary ? 'utf8' : undefined,
    });
    let childSummary = null;
    if (args.jsonSummary) {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      childSummary = extractJsonSummary(`${res.stdout || ''}\n${res.stderr || ''}`);
    }
    const durationMs = Date.now() - started;
    if (res.status === 0) {
      ok++;
      logger.write('pair-finish', { pairKey: pairKey(p), status: 'ok', exitCode: res.status, durationMs, summary: childSummary });
      if (childSummary && Array.isArray(childSummary.tabs)) {
        childSummary.tabs.forEach((tab) => logger.write('tab-finish', { pairKey: pairKey(p), teacherId: p.gv_folder_id, sheetId: p.sheet_id, ...tab }));
      }
      if (childSummary && Array.isArray(childSummary.preserveRisks)) {
        childSummary.preserveRisks.forEach((risk) => logger.write('preserve-risk', { pairKey: pairKey(p), teacherId: p.gv_folder_id, sheetId: p.sheet_id, ...risk }));
      }
    }
    else {
      failed++;
      logger.write('pair-finish', { pairKey: pairKey(p), status: 'failed', exitCode: res.status, signal: res.signal, durationMs, summary: childSummary });
      if (!args.continueOnError) {
        logger.finish({ mode: args.mode, total: pairs.length, ready: ready.length, ok, failed, skipped: skipped.length, backups: backups.size, stoppedAtPair: i + 1 });
        process.exit(res.status || 1);
      }
    }
  }

  console.log(`\nDone. ok=${ok}, failed=${failed}, skipped=${skipped.length}`);
  const summary = { mode: args.mode, total: pairs.length, ready: ready.length, ok, failed, skipped: skipped.length, backups: backups.size };
  logger.finish(summary);
  if (args.jsonSummary) {
    const summaryPath = path.join(TOOL_DIR, 'run-logs', `${logger.runId}.summary.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({ runId: logger.runId, summary }, null, 2));
    console.log(`JSON summary: ${summaryPath}`);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
