#!/usr/bin/env node
// Full-spreadsheet backup and rollback helpers for Drive-to-Sheet syncs.

const { withRetry } = require('./utils');
const { getClients } = require('./auth');
const { getSpreadsheet } = require('./sheet');

function safeNamePart(value, fallback = 'run') {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildBackupName(sourceName, opts = {}) {
  const marker = safeNamePart(opts.runId || backupTimestamp(opts.date), 'backup');
  return `[BACKUP ${marker}] ${String(sourceName || 'Spreadsheet')}`;
}

async function getDriveFile(drive, fileId, fields = 'id,name,parents,mimeType,webViewLink,createdTime') {
  const res = await withRetry(
    () => drive.files.get({ fileId, fields, supportsAllDrives: true }),
    { context: `get Drive file ${fileId}` },
  );
  return res.data;
}

async function backupSpreadsheet(drive, spreadsheetId, opts = {}) {
  const source = await getDriveFile(drive, spreadsheetId);
  const requestBody = {
    name: opts.name || buildBackupName(source.name, opts),
  };
  if (Array.isArray(source.parents) && source.parents.length) {
    requestBody.parents = source.parents;
  }
  const res = await withRetry(
    () => drive.files.copy({
      fileId: spreadsheetId,
      supportsAllDrives: true,
      fields: 'id,name,parents,webViewLink,createdTime',
      requestBody,
    }),
    { context: `copy spreadsheet backup ${spreadsheetId}`, maxRetries: 4 },
  );
  return {
    sourceId: spreadsheetId,
    sourceName: source.name,
    backupId: res.data.id,
    backupName: res.data.name,
    webViewLink: res.data.webViewLink,
    createdTime: res.data.createdTime,
  };
}

async function restoreSpreadsheetFromBackup(sheets, backupSpreadsheetId, targetSpreadsheetId, opts = {}) {
  if (!opts.yes) {
    throw new Error('Restore is destructive. Re-run with --yes after confirming backup and target ids.');
  }
  if (backupSpreadsheetId === targetSpreadsheetId) {
    throw new Error('backup and target spreadsheet ids must be different.');
  }

  const source = await getSpreadsheet(sheets, backupSpreadsheetId);
  const sourceSheets = (source.sheets || []).map((s) => ({
    sheetId: s.properties.sheetId,
    title: s.properties.title,
    index: s.properties.index || 0,
  })).sort((a, b) => a.index - b.index);
  if (!sourceSheets.length) throw new Error(`backup spreadsheet ${backupSpreadsheetId} has no sheets.`);

  const tempTitle = `__ROLLBACK_TEMP_${Date.now()}`;
  const addTemp = await withRetry(
    () => sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetSpreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tempTitle } } }] },
    }),
    { context: `create rollback temp sheet ${targetSpreadsheetId}` },
  );
  const tempSheetId = addTemp.data.replies[0].addSheet.properties.sheetId;

  const target = await getSpreadsheet(sheets, targetSpreadsheetId);
  const deleteRequests = (target.sheets || [])
    .map((s) => s.properties.sheetId)
    .filter((sheetId) => sheetId !== tempSheetId)
    .map((sheetId) => ({ deleteSheet: { sheetId } }));
  if (deleteRequests.length) {
    await withRetry(
      () => sheets.spreadsheets.batchUpdate({
        spreadsheetId: targetSpreadsheetId,
        requestBody: { requests: deleteRequests },
      }),
      { context: `clear target sheets ${targetSpreadsheetId}` },
    );
  }

  const copiedSheets = [];
  for (const sourceSheet of sourceSheets) {
    const copied = await withRetry(
      () => sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: backupSpreadsheetId,
        sheetId: sourceSheet.sheetId,
        requestBody: { destinationSpreadsheetId: targetSpreadsheetId },
      }),
      { context: `copy backup tab ${sourceSheet.title}` },
    );
    copiedSheets.push({
      sheetId: copied.data.sheetId,
      title: sourceSheet.title,
      index: sourceSheet.index,
    });
  }

  const finalizeRequests = copiedSheets.map((s) => ({
    updateSheetProperties: {
      properties: { sheetId: s.sheetId, title: s.title, index: s.index },
      fields: 'title,index',
    },
  }));
  finalizeRequests.push({ deleteSheet: { sheetId: tempSheetId } });
  await withRetry(
    () => sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetSpreadsheetId,
      requestBody: { requests: finalizeRequests },
    }),
    { context: `finalize rollback ${targetSpreadsheetId}` },
  );

  return {
    backupSpreadsheetId,
    targetSpreadsheetId,
    restoredSheets: copiedSheets.map((s) => s.title),
  };
}

function parseArgs(argv) {
  const out = { sheet: '', backup: '', target: '', runId: '', restore: false, yes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet') out.sheet = argv[++i];
    else if (a === '--backup') out.backup = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--restore') out.restore = true;
    else if (a === '--yes') out.yes = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const { drive, sheets } = await getClients();
  if (args.restore) {
    if (!args.backup || !args.target) throw new Error('Usage: node backup.js --restore --backup <backupSheetId> --target <targetSheetId> --yes');
    const restored = await restoreSpreadsheetFromBackup(sheets, args.backup, args.target, { yes: args.yes });
    console.log(JSON.stringify(restored, null, 2));
    return;
  }
  if (!args.sheet) throw new Error('Usage: node backup.js --sheet <spreadsheetId> [--run-id <runId>]');
  const backup = await backupSpreadsheet(drive, args.sheet, { runId: args.runId });
  console.log(JSON.stringify(backup, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('ERROR:', err.message);
    if (err.response && err.response.data) console.error(JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  });
}

module.exports = {
  backupSpreadsheet,
  restoreSpreadsheetFromBackup,
  buildBackupName,
  backupTimestamp,
  safeNamePart,
};
