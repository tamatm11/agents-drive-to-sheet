const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVirtualLessonsForNode,
  computeRenderableLessonChecksum,
  extractRenderableLessons,
} = require('../lesson-model');

test('virtual lessons group direct resource files by detected lesson key', () => {
  const node = {
    id: 'chapter-1',
    name: 'Chapter 1',
    modifiedTime: '2026-05-01T00:00:00.000Z',
    files: [
      { id: 'v1', name: 'Theme 01 video.mp4', mimeType: 'video/mp4', modifiedTime: '2026-05-02T00:00:00.000Z' },
      { id: 'p1', name: 'Theme 01 handout.pdf', mimeType: 'application/pdf', modifiedTime: '2026-05-03T00:00:00.000Z' },
      { id: 'v2', name: 'Theme 02 video.mp4', mimeType: 'video/mp4', modifiedTime: '2026-05-04T00:00:00.000Z' },
    ],
    children: [],
  };
  const lessons = buildVirtualLessonsForNode(node, 0);
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0].id, 'chapter-1::theme:1');
  assert.equal(lessons[0].files.length, 2);
});

test('extractRenderableLessons includes concrete lessons with stable checksum', () => {
  const course = {
    id: 'course-1',
    name: 'Course',
    children: [{
      id: 'chapter-1',
      name: 'Chapter',
      modifiedTime: '2026-05-01T00:00:00.000Z',
      files: [],
      children: [{
        id: 'lesson-1',
        name: 'ABC01 Lesson',
        modifiedTime: '2026-05-01T00:00:00.000Z',
        children: [],
        files: [{ id: 'f1', name: 'Video.mp4', mimeType: 'video/mp4', modifiedTime: '2026-05-02T00:00:00.000Z' }],
      }],
    }],
  };
  const lessons = extractRenderableLessons(course);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].id, 'lesson-1');
  assert.equal(lessons[0].checksum, computeRenderableLessonChecksum(course.children[0].children[0]));
});
