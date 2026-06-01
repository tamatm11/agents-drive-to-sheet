const fs = require('fs');
const { execSync } = require('child_process');

const pairingData = JSON.parse(fs.readFileSync('./pairing_cache.json', 'utf8'));
const pairs = pairingData.pairs;

console.log(`\n🚀 FULL RENDER SYNC: ${pairs.length} teachers\n`);
console.log('='.repeat(100));

let successCount = 0;
let failCount = 0;
const startTime = Date.now();

for (let i = 0; i < pairs.length; i++) {
  const pair = pairs[i];
  const teacherFolderId = pair.source.folder_id;
  const teacherName = pair.source.folder_name.substring(0, 55);
  
  const idx = String(i + 1).padStart(2);
  process.stdout.write(`[${idx}/${pairs.length}] ${teacherName}... `);
  
  try {
    execSync(`node tool/render.js --teacher ${teacherFolderId} 2>&1 | tail -5`, {
      stdio: 'pipe'
    });
    
    console.log('✓ OK');
    successCount++;
  } catch (err) {
    console.log('✗ FAIL');
    failCount++;
    console.log(`       Error: ${err.message.split('\n')[0].substring(0, 80)}`);
  }
  
  if ((i + 1) % 5 === 0) {
    console.log(`   └─> ${successCount}✓ OK, ${failCount}✗ FAIL so far`);
  }
}

const duration = Math.round((Date.now() - startTime) / 1000);

console.log('\n' + '='.repeat(100));
console.log(`✅ FINAL RESULT: ${successCount}✓ OK, ${failCount}✗ FAIL`);
console.log(`⏱️  Total time: ${duration}s (~${Math.round(duration/60)}m)`);
console.log(`📊 Success rate: ${Math.round(successCount/pairs.length * 100)}%`);
console.log('='.repeat(100));
