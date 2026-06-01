const fs = require('fs');
const { execSync } = require('child_process');

const pairingData = JSON.parse(fs.readFileSync('./pairing_cache.json', 'utf8'));
const pairs = pairingData.pairs;

console.log(`\n🚀 FULL APPLY MODE: Processing ${pairs.length} teachers\n`);
console.log('='.repeat(100));

let successCount = 0;
let failCount = 0;
const results = [];
const startTime = Date.now();

for (let i = 0; i < pairs.length; i++) {
  const pair = pairs[i];
  const teacherFolderId = pair.source.folder_id;
  const teacherName = pair.source.folder_name.substring(0, 55);
  const destSheetId = pair.dest.sheet_id;
  
  const idx = String(i + 1).padStart(2);
  process.stdout.write(`[${idx}/${pairs.length}] ${teacherName}... `);
  
  try {
    // Run render.js for this teacher
    execSync(`node tool/render.js --teacher ${teacherFolderId} 2>/dev/null`, {
      stdio: 'pipe'
    });
    
    console.log('✓ OK');
    successCount++;
    results.push({ idx: i+1, status: '✓', name: teacherName });
  } catch (err) {
    console.log('✗ FAIL');
    failCount++;
    results.push({ idx: i+1, status: '✗', name: teacherName, error: err.message.substring(0, 50) });
  }
  
  // Report every 5 sheets
  if ((i + 1) % 5 === 0) {
    console.log(`   → ${successCount}✓ OK, ${failCount}✗ FAIL`);
  }
}

const duration = Math.round((Date.now() - startTime) / 1000);

console.log('\n' + '='.repeat(100));
console.log(`✅ FINAL REPORT: ${successCount}✓ OK, ${failCount}✗ FAIL`);
console.log(`⏱️  Total time: ${duration}s (${Math.round(duration/60)}m)`);
console.log('='.repeat(100));

if (failCount > 0) {
  console.log('\n❌ FAILED SHEETS:');
  results.filter(r => r.status === '✗').forEach(r => {
    console.log(`   [${r.idx}] ${r.name}`);
    if (r.error) console.log(`       → ${r.error}`);
  });
}
