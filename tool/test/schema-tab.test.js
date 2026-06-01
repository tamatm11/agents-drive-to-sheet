const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSchema } = require('../utils');
const { shortenTabName } = require('../sheet');
const { dedupeTabNames } = require('../render');

test('validateSchema accepts the renderer schema contract', () => {
  assert.equal(validateSchema({
    levels: [{ depth: 0, label: 'Chapter' }],
    leafFallback: { label: 'Lesson' },
    courseRow: { label: 'Course' },
  }), true);
});

test('validateSchema rejects malformed schemas early', () => {
  assert.throws(() => validateSchema({ levels: [{}] }), /Schema validation failed/);
});

test('dedupeTabNames keeps tab names unique after shortening', () => {
  const plan = [
    { tabName: 'Physics 12', course: { name: 'Physics 12 A' } },
    { tabName: 'Physics 12', course: { name: 'Physics 12 B' } },
  ];
  dedupeTabNames(plan, shortenTabName, '');
  assert.notEqual(plan[0].tabName, plan[1].tabName);
});
