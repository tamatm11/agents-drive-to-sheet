const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATE_SCHEMA_VERSION,
  diffCourse,
  findOrphanTabs,
  markArchived,
  markRendered,
} = require('../sync-state');

function course(id = 'course-1') {
  return {
    id,
    name: 'Course',
    modifiedTime: '2026-05-01T00:00:00.000Z',
    files: [],
    children: [{
      id: `${id}-lesson`,
      name: 'Lesson 1',
      modifiedTime: '2026-05-02T00:00:00.000Z',
      children: [],
      files: [{ id: `${id}-file`, name: 'Video.mp4', mimeType: 'video/mp4', modifiedTime: '2026-05-02T00:00:00.000Z' }],
    }],
  };
}

test('state schema version is v3', () => {
  assert.equal(STATE_SCHEMA_VERSION, 3);
});

test('markRendered stores tab id and style metadata', () => {
  const state = { tabs: {} };
  markRendered(state, course(), 'Tab A', {
    tabId: 456,
    spreadsheetId: 'sheet-1',
    rendererVersion: 'r1',
    styleVersion: 's1',
    stats: { leafCount: 1 },
  });
  assert.equal(state.tabs['course-1'].tabId, 456);
  assert.equal(state.tabs['course-1'].spreadsheetId, 'sheet-1');
  assert.equal(state.tabs['course-1'].styleVersion, 's1');
  assert.equal(state.tabs['course-1'].stats.leafCount, 1);
});

test('diffCourse changes when style version changes', () => {
  const state = { tabs: {} };
  const c = course();
  markRendered(state, c, 'Tab A', { styleVersion: 'old-style' });
  const diff = diffCourse(state, c, 'Tab A', { styleVersion: 'new-style' });
  assert.equal(diff.action, 'changed');
  assert.match(diff.reason, /style old-style -> new-style/);
});

test('archived orphans are hidden from normal orphan reports but remain auditable', () => {
  const state = { tabs: {} };
  markRendered(state, course(), 'Tab A', { tabId: 456, spreadsheetId: 'sheet-1' });
  assert.equal(findOrphanTabs(state, []).length, 1);
  markArchived(state, 'course-1', 'ARCHIVED Tab A', { tabId: 456, spreadsheetId: 'sheet-1' });
  assert.equal(findOrphanTabs(state, []).length, 0);
  const archived = findOrphanTabs(state, [], { includeArchived: true });
  assert.equal(archived.length, 1);
  assert.equal(state.tabs['course-1'].archivedTabName, 'ARCHIVED Tab A');
});
