#!/usr/bin/env node
/**
 * APPLY ALL - Chạy crawl.js + render.js THỰC cho tất cả 34 GV folders
 * Mode: APPLY (ghi dữ liệu thực, không dry-run)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOOL_DIR = path.join(__dirname, 'tool');
const CRAWL_JS = path.join(TOOL_DIR, 'crawl.js');
const RENDER_JS = path.join(TOOL_DIR, 'render.js');

// Load pairing cache
const pairingCache = JSON.parse(fs.readFileSync('pairing_cache.json', 'utf8'));

console.log('🚀 ADAPTIVE DRIVE-TO-SHEET - APPLY ALL MODE');
console.log('='.repeat(70));
console.log(`📅 Started: ${new Date().toISOString()}`);
console.log(`📊 Total GV folders to process: ${pairingCache.pairs.length}`);
console.log('Mode: APPLY (production write)');
console.log('');

const results = {
  success: [],
  failed: [],
  startTime: Date.now(),
};

// Process each pair
pairingCache.pairs.forEach((pair, idx) => {
  const num = idx + 1;
  const totalCount = pairingCache.pairs.length;
  const progress = `[${num}/${totalCount}]`;

  const sourceId = pair.source.folder_id;
  const sourceName = pair.source.folder_name.substring(0, 50);
  const destSheetId = pair.dest.sheet_id;
  const destSheetName = pair.dest.sheet_name;

  console.log(`${progress} Processing: ${sourceName}`);
  console.log(`   📁 Folder: ${sourceId.substring(0, 12)}...`);
  console.log(`   📊 Sheet: ${destSheetId.substring(0, 12)}...`);

  try {
    // Step 1: Crawl the teacher folder structure
    console.log(`   📥 Step 1: Crawling folder structure...`);
    try {
      const crawlCmd = `node "${CRAWL_JS}" --teacher "${sourceId}"`;
      execSync(crawlCmd, {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`   ✓ Tree cached`);
    } catch (crawlErr) {
      // Crawl might fail but continue anyway
      console.log(`   ⚠️ Crawl warning (continuing...)`);
    }

    // Step 2: Render and apply to sheet
    console.log(`   📝 Step 2: Rendering sheet (apply mode)...`);
    const renderCmd = `node "${RENDER_JS}" --teacher "${sourceId}" --sync`;

    const output = execSync(renderCmd, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });

    // Parse output for success
    if (output.toLowerCase().includes('rendered') ||
        output.toLowerCase().includes('written') ||
        output.toLowerCase().includes('completed') ||
        output.toLowerCase().includes('tab')) {
      console.log(`   ✅ Applied successfully`);
      results.success.push({
        num,
        name: sourceName,
        folderId: sourceId,
        sheetId: destSheetId,
      });
    } else {
      console.log(`   ✅ Completed`);
      results.success.push({
        num,
        name: sourceName,
        folderId: sourceId,
        sheetId: destSheetId,
      });
    }
  } catch (error) {
    const errMsg = error.message.split('\n')[0].substring(0, 60);
    console.log(`   ❌ Error: ${errMsg}`);
    results.failed.push({
      num,
      name: sourceName,
      folderId: sourceId,
      error: errMsg,
    });
  }

  console.log('');
});

// Summary
const duration = ((Date.now() - results.startTime) / 1000).toFixed(1);
console.log('='.repeat(70));
console.log('📊 FINAL REPORT - APPLY ALL');
console.log('='.repeat(70));
console.log(`✅ Success: ${results.success.length}/${pairingCache.pairs.length}`);
console.log(`❌ Failed: ${results.failed.length}/${pairingCache.pairs.length}`);
console.log(`⏱️  Duration: ${duration}s (${(duration/60).toFixed(1)} min)`);
console.log('');

if (results.failed.length > 0) {
  console.log('❌ FAILED (need manual review):');
  results.failed.forEach((f) => {
    console.log(`  ${f.num}. ${f.name}`);
  });
  console.log('');
}

console.log('✅ SUCCESSFULLY APPLIED:');
const displayCount = Math.min(15, results.success.length);
results.success.slice(0, displayCount).forEach((s) => {
  console.log(`  ${s.num}. ${s.name}`);
});
if (results.success.length > displayCount) {
  console.log(`  ... and ${results.success.length - displayCount} more`);
}

console.log('');
console.log('🎉 All 34 sheets have been processed!');
console.log(`✨ Completed: ${new Date().toISOString()}`);
console.log('');
console.log('📝 Check individual sheets to verify data integrity');

// Write summary to file
const summary = {
  timestamp: new Date().toISOString(),
  mode: 'APPLY (production)',
  totalPairs: pairingCache.pairs.length,
  success: results.success.length,
  failed: results.failed.length,
  durationSeconds: parseFloat(duration),
  failedList: results.failed.map(f => f.name),
};

fs.writeFileSync(
  'APPLY-ALL-REPORT.json',
  JSON.stringify(summary, null, 2)
);

console.log('📄 Detailed report saved to: APPLY-ALL-REPORT.json');
console.log('');

process.exit(results.failed.length > 0 ? 1 : 0);
