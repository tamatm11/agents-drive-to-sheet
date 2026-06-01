#!/usr/bin/env node
// test-smoke.js — Smoke tests to validate pipeline before production deployment

const { getClients } = require('./auth');
const { loadCachedTree } = require('./crawl');
const { loadCachedSchema } = require('./infer-schema');
const { validateSchema } = require('./utils');
const fs = require('fs');
const path = require('path');

// Test teacher: Thầy Ái (already tested in production)
const TEST_TEACHER_ID = '18eBA7PeCBEYILYv7h6a4rIxqZvaSFX8t';
const TEST_SHEET_ID = '19W7flY2MrR-hKLqQxWqYqxqxqxqxqxqx'; // Replace with actual

async function smokeTest() {
  console.log('🧪 Running smoke tests...\n');
  const results = { passed: 0, failed: 0, errors: [] };

  // Test 1: Auth works
  try {
    console.log('Test 1: Authentication...');
    const { drive, sheets } = await getClients();
    console.log('  ✓ Auth successful\n');
    results.passed++;
  } catch (err) {
    console.error('  ❌ Auth failed:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Auth', error: err.message });
    return results; // Can't continue without auth
  }

  // Test 2: Tree cache exists and valid
  try {
    console.log('Test 2: Tree cache...');
    const tree = loadCachedTree(TEST_TEACHER_ID);
    if (!tree) {
      throw new Error('Tree cache not found. Run: node crawl.js --teacher ' + TEST_TEACHER_ID);
    }
    if (!tree.courses || tree.courses.length === 0) {
      throw new Error('Tree cache has no courses');
    }
    console.log(`  ✓ Tree cache valid (${tree.courses.length} courses)\n`);
    results.passed++;
  } catch (err) {
    console.error('  ❌ Tree cache invalid:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Tree cache', error: err.message });
  }

  // Test 3: Schema exists and valid
  try {
    console.log('Test 3: Schema validation...');
    const schemaData = loadCachedSchema(TEST_TEACHER_ID);
    if (!schemaData) {
      throw new Error('Schema not found. Run: node infer-schema.js --teacher ' + TEST_TEACHER_ID);
    }
    validateSchema(schemaData.schema);
    console.log('  ✓ Schema valid\n');
    results.passed++;
  } catch (err) {
    console.error('  ❌ Schema invalid:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Schema validation', error: err.message });
  }

  // Test 4: Sync-state directory exists
  try {
    console.log('Test 4: Sync-state directory...');
    const statesDir = path.join(__dirname, 'sync-states');
    if (!fs.existsSync(statesDir)) {
      fs.mkdirSync(statesDir, { recursive: true });
      console.log('  ⚠ Created sync-states directory');
    }
    console.log('  ✓ Sync-state directory exists\n');
    results.passed++;
  } catch (err) {
    console.error('  ❌ Sync-state directory check failed:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Sync-state directory', error: err.message });
  }

  // Test 5: All required directories exist
  try {
    console.log('Test 5: Required directories...');
    const dirs = ['trees', 'schemas', 'schemas-v2', 'sync-states'];
    for (const dir of dirs) {
      const p = path.join(__dirname, dir);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        console.log(`  ⚠ Created ${dir} directory`);
      }
    }
    console.log('  ✓ All required directories exist\n');
    results.passed++;
  } catch (err) {
    console.error('  ❌ Directory check failed:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Required directories', error: err.message });
  }

  // Test 6: Validate all existing schemas
  try {
    console.log('Test 6: Validate all schemas...');
    const schemasDir = path.join(__dirname, 'schemas');
    const schemaFiles = fs.readdirSync(schemasDir).filter(f => f.endsWith('.json'));
    let validCount = 0;
    let invalidCount = 0;

    for (const file of schemaFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(schemasDir, file), 'utf8'));
        validateSchema(content.schema);
        validCount++;
      } catch (err) {
        console.error(`  ⚠ Invalid schema: ${file} - ${err.message}`);
        invalidCount++;
      }
    }

    console.log(`  ✓ Validated ${validCount} schemas (${invalidCount} invalid)\n`);
    if (invalidCount > 0) {
      results.failed++;
      results.errors.push({ test: 'Schema validation', error: `${invalidCount} invalid schemas` });
    } else {
      results.passed++;
    }
  } catch (err) {
    console.error('  ❌ Schema validation failed:', err.message, '\n');
    results.failed++;
    results.errors.push({ test: 'Schema validation', error: err.message });
  }

  return results;
}

// Run tests
smokeTest()
  .then(results => {
    console.log('━'.repeat(60));
    console.log(`\n📊 Test Results: ${results.passed} passed, ${results.failed} failed\n`);

    if (results.failed > 0) {
      console.log('❌ FAILED TESTS:\n');
      results.errors.forEach(e => {
        console.log(`  - ${e.test}: ${e.error}`);
      });
      console.log('\n⚠ Fix errors before deploying to production.\n');
      process.exit(1);
    } else {
      console.log('✅ All smoke tests passed! Safe to deploy.\n');
      process.exit(0);
    }
  })
  .catch(err => {
    console.error('\n💥 Smoke test suite crashed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
