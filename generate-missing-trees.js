const fs = require('fs');
const { execSync } = require('child_process');

const pairingData = JSON.parse(fs.readFileSync('./pairing_cache.json', 'utf8'));
const pairs = pairingData.pairs;

// Get existing tree files
const existingTrees = new Set(
  fs.readdirSync('./tool/trees').filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
);

const missingTeachers = [];
for (const pair of pairs) {
  const teacherId = pair.source.folder_id;
  if (!existingTrees.has(teacherId)) {
    missingTeachers.push({
      id: teacherId,
      name: pair.source.folder_name.substring(0, 50)
    });
  }
}

console.log(`\n📊 Cache Status:`);
console.log(`   Existing: ${existingTrees.size} trees`);
console.log(`   Missing: ${missingTeachers.length} trees`);
console.log(`   Total: ${pairs.length}`);

if (missingTeachers.length === 0) {
  console.log(`\n✅ All trees are cached!`);
  process.exit(0);
}

console.log(`\n🔄 Generating missing trees...`);
let successCount = 0;
let failCount = 0;

for (let i = 0; i < missingTeachers.length; i++) {
  const teacher = missingTeachers[i];
  const idx = String(i + 1).padStart(2);
  
  process.stdout.write(`[${idx}/${missingTeachers.length}] ${teacher.name}... `);
  
  try {
    execSync(`node tool/crawl.js --teacher ${teacher.id} --force 2>&1 | tail -1`, {
      stdio: 'pipe'
    });
    console.log('✓');
    successCount++;
  } catch (err) {
    console.log('✗');
    failCount++;
  }
}

console.log(`\n✅ Generated ${successCount} trees, ${failCount} failed`);
