const assert = require('assert/strict');
const { shortenTabName, appendTabNameSuffix } = require('./sheet');
const { dedupeTabNames } = require('./render');

function planItem(name, tabName, courseCfg = null) {
  return { course: { name }, tabName, courseCfg };
}

{
  const raw = 'A:B/C?D*E[F]\\G';
  const tab = shortenTabName(raw, 99);
  assert(!/[\\/?*\[\]:]/.test(tab), `tab still has invalid chars: ${tab}`);
}

{
  const base = shortenTabName('X'.repeat(140), 99);
  const suffixed = appendTabNameSuffix(base, '(2)', 99);
  assert(suffixed.length <= 99);
  assert(suffixed.endsWith('(2)'));
  assert.notEqual(suffixed, base);
}

{
  const plan = [
    planItem('1. KHOA LONG NAME ' + 'A'.repeat(140), shortenTabName('X'.repeat(140), 99)),
    planItem('2. KHOA LONG NAME ' + 'A'.repeat(140), shortenTabName('X'.repeat(140), 99)),
    planItem('3. KHOA LONG NAME ' + 'A'.repeat(140), shortenTabName('X'.repeat(140), 99)),
  ];
  dedupeTabNames(plan, shortenTabName);
  const keys = plan.map((p) => p.tabName.toLowerCase());
  assert.equal(new Set(keys).size, plan.length);
  assert(plan.every((p) => p.tabName.length <= 99));
  assert(plan[1].tabName.endsWith('(2)'));
  assert(plan[2].tabName.endsWith('(3)'));
}

{
  const plan = [
    planItem('schema fixed', 'Khóa T', { tabName: 'Khóa T' }),
    planItem('1. KHÓA T NỀN TẢNG TOÁN 12', 'Khóa T'),
  ];
  dedupeTabNames(plan, shortenTabName);
  assert.equal(plan[0].tabName, 'Khóa T');
  assert.notEqual(plan[1].tabName.toLowerCase(), 'khóa t');
  assert(!plan[1].tabName.endsWith('(2)'), `auto tab should expand before suffixing: ${plan[1].tabName}`);
}

{
  const plan = [
    planItem('1. KHÓA T', 'Khóa T'),
    planItem('2. KHÓA T', 'KHÓA T'),
  ];
  dedupeTabNames(plan, shortenTabName);
  assert.equal(new Set(plan.map((p) => p.tabName.toLowerCase())).size, 2);
}

console.log('tab naming tests passed');
