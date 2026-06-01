const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LESSON_ID_HEADER,
  buildCourseTab,
  snapshotUserEditsDetailed,
} = require('../render');

function sampleCourse() {
  return {
    id: 'course-1',
    name: '1. KHOA TEST',
    webViewLink: 'https://drive.google.com/drive/folders/course-1',
    modifiedTime: '2026-05-01T00:00:00.000Z',
    files: [],
    children: [{
      id: 'chapter-1',
      name: 'Chapter 1',
      webViewLink: 'https://drive.google.com/drive/folders/chapter-1',
      modifiedTime: '2026-05-01T00:00:00.000Z',
      files: [],
      children: [{
        id: 'lesson-1',
        name: 'TST01 First lesson',
        webViewLink: 'https://drive.google.com/drive/folders/lesson-1',
        modifiedTime: '2026-05-02T00:00:00.000Z',
        children: [],
        files: [{
          id: 'file-1',
          name: 'TST01 video.mp4',
          mimeType: 'video/mp4',
          modifiedTime: '2026-05-02T00:00:00.000Z',
          webViewLink: 'https://drive.google.com/file/d/file-1/view',
        }],
      }],
    }],
  };
}

const schema = {
  levels: [{ depth: 0, label: 'Chapter', icon: '', bold: true }],
  leafFallback: { label: 'Lesson', icon: '', bold: false },
  courseRow: { icon: '', bold: true },
};

test('buildCourseTab appends hidden lesson id contract column', () => {
  const built = buildCourseTab(sampleCourse(), schema, { maxVideos: 8, allFiles: false });
  assert.equal(built.header.at(-1), LESSON_ID_HEADER);
  assert.equal(built.NCOL, built.header.length);
  assert.equal(built.colWidths.length, built.NCOL);
  const lessonRow = built.rows.find((row) => row.at(-1) === 'lesson-1');
  assert.ok(lessonRow, 'lesson row carries stable lesson id');
});

test('snapshotUserEditsDetailed prefers _lesson_id over display name', async () => {
  const fakeSheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 123, title: 'Tab A' } }] } }),
      values: {
        get: async () => ({
          data: {
            values: [
              ['banner'],
              ['STT', 'Ten', 'Cap nhat', 'Trang thai', 'Ghi chu', LESSON_ID_HEADER],
              ['', 'renamed display text', '', 'Hoan thanh', 'keep me', 'lesson-1'],
            ],
          },
        }),
      },
    },
  };
  const snapshot = await snapshotUserEditsDetailed(fakeSheets, 'sheet-1', 'Tab A', sampleCourse());
  assert.equal(snapshot.edits.get('lesson-1').status, 'Hoan thanh');
  assert.equal(snapshot.edits.get('lesson-1').note, 'keep me');
  assert.equal(snapshot.diagnostics.usedLessonId, 1);
  assert.deepEqual(snapshot.diagnostics.blockingRisks, []);
});

test('snapshotUserEditsDetailed reports duplicate-name preserve risk for legacy tabs', async () => {
  const course = sampleCourse();
  course.children[0].children.push({
    ...course.children[0].children[0],
    id: 'lesson-2',
  });
  const fakeSheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 123, title: 'Tab A' } }] } }),
      values: {
        get: async () => ({
          data: {
            values: [
              ['banner'],
              ['STT', 'Ten', 'Cap nhat', 'Trang thai', 'Ghi chu'],
              ['', 'TST01 First lesson', '', 'Dang hoc', 'ambiguous'],
            ],
          },
        }),
      },
    },
  };
  const snapshot = await snapshotUserEditsDetailed(fakeSheets, 'sheet-1', 'Tab A', course);
  assert.equal(snapshot.edits.size, 0);
  assert.equal(snapshot.diagnostics.blockingRisks.length, 1);
});
