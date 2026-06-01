const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pairingCachePath = './pairing_cache.json';
const pairingData = JSON.parse(fs.readFileSync(pairingCachePath, 'utf8'));

const pairs = pairingData.pairs;
console.log(`Found ${pairs.length} teacher pairs to process`);
console.log('='.repeat(80));

let successCount = 0;
let failCount = 0;
const results = [];
const batchSize = 5;

for (let i = 0; i < pairs.length; i++) {
  const pair = pairs[i];
  const teacherFolderId = pair.source.folder_id;
  const teacherName = pair.source.folder_name.substring(0, 50);
  const destSheetId = pair.dest.sheet_id;
  
  console.log(`\n[${String(i+1).padStart(2)}/${pairs.length}] ${teacherName}...`);
  
  try {
    execSync(`node tool/crawl.js --teacher ${teacherFolderId} 2>&1 | tail -3`, { stdio: 'inherit' });
    execSync(`node tool/render.js --teacher ${teacherFolderId} 2>&1 | tail -3`, { stdio: 'inherit' });
    
    successCount++;
    results.push({ idx: i+1, status: '✓' });
  } catch (err) {
    failCount++;
    results.push({ idx: i+1, status: '✗' });
  }
  
  if ((i + 1) % batchSize === 0) {
    console.log(`\n>>> Processed ${i+1}/${pairs.length} (${successCount} OK, ${failCount} FAIL)`);
  }
}

console.log('\n' + '='.repeat(80));
console.log(`FINAL: ${successCount}✓ OK, ${failCount}✗ FAIL (Total: ${pairs.length})`);
