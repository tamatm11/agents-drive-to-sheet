const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBackupName, safeNamePart } = require('../backup');

test('safeNamePart keeps run ids filesystem and Drive friendly', () => {
  assert.equal(safeNamePart('sync 2026/05/31:bad'), 'sync-2026-05-31-bad');
});

test('buildBackupName includes stable run id and source name', () => {
  const name = buildBackupName('Math Sheet', { runId: 'nightly-20260531' });
  assert.equal(name, '[BACKUP nightly-20260531] Math Sheet');
});
