# Pre-Deployment Improvements for Adaptive Drive-to-Sheet Agent

**Review Date:** 2026-05-29  
**Status:** Critical improvements needed before scaling to 46+ teachers  
**Current State:** 2 teachers tested successfully (Thầy Chí, Thầy Ái)

---

## 🔴 CRITICAL ISSUES (Must Fix Before Scale Deployment)

### 1. **Missing Error Recovery in Batch Operations**

**Problem:** `render.js` and `crawl.js` lack comprehensive error handling for API failures during batch operations. When processing 46 teachers, network failures or quota limits will cause partial failures without recovery.

**Impact:** 
- Partial data corruption (some tabs written, others failed)
- Lost progress when API quota exceeded
- No automatic retry for transient failures

**Fix Required:**

```javascript
// In render.js - Add retry wrapper for API calls
async function withRetry(fn, maxRetries = 3, backoffMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      if (err.code === 429 || err.code === 503) {
        const delay = backoffMs * Math.pow(2, i);
        console.log(`  ⚠ API error ${err.code}, retry ${i+1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err; // Non-retryable error
      }
    }
  }
}

// Wrap all Drive/Sheets API calls
const meta = await withRetry(() => drive.files.get({ fileId: teacherFolderId, ... }));
```

**Location:** `tool/render.js`, `tool/crawl.js`, `tool/sheet.js`

---

### 2. **No Validation of User-Edit Preservation**

**Problem:** `snapshotUserEdits()` silently fails when lesson names change or contain special characters. No validation that user edits were actually restored.

**Impact:**
- Students lose their "Trạng thái" and "Ghi chú" data without warning
- No audit trail of what was preserved vs lost

**Fix Required:**

```javascript
// In render.js - Add validation after restore
async function validateUserEditRestore(beforeSnapshot, afterRender, courseNode) {
  const stats = { preserved: 0, lost: 0, lostLessons: [] };
  for (const [lessonId, edits] of beforeSnapshot.entries()) {
    const lessonNode = findLessonById(courseNode, lessonId);
    if (!lessonNode) {
      stats.lost++;
      stats.lostLessons.push({ id: lessonId, edits });
    } else {
      stats.preserved++;
    }
  }
  if (stats.lost > 0) {
    console.warn(`  ⚠ Lost user-edits for ${stats.lost} lessons (renamed or removed):`);
    stats.lostLessons.forEach(l => console.warn(`    - ${l.id}: ${JSON.stringify(l.edits)}`));
  }
  return stats;
}
```

**Location:** `tool/render.js` after `buildCourseTab()`

---

### 3. **Race Condition in Concurrent Teacher Processing**

**Problem:** When agent processes multiple teachers in parallel (FULL mode), shared resources (auth tokens, rate limits) can cause conflicts.

**Impact:**
- Auth token refresh conflicts
- Quota exhaustion without proper backoff
- Unpredictable failures in batch runs

**Fix Required:**

```javascript
// Add semaphore for concurrent teacher processing
class RateLimiter {
  constructor(maxConcurrent = 3, quotaPerMinute = 100) {
    this.maxConcurrent = maxConcurrent;
    this.quotaPerMinute = quotaPerMinute;
    this.active = 0;
    this.queue = [];
    this.callsThisMinute = 0;
    this.minuteStart = Date.now();
  }
  
  async acquire() {
    while (this.active >= this.maxConcurrent || this.callsThisMinute >= this.quotaPerMinute) {
      if (Date.now() - this.minuteStart > 60000) {
        this.callsThisMinute = 0;
        this.minuteStart = Date.now();
      }
      await new Promise(r => setTimeout(r, 100));
    }
    this.active++;
    this.callsThisMinute++;
  }
  
  release() {
    this.active--;
  }
}

// Use in agent main loop
const limiter = new RateLimiter(3, 100);
for (const teacher of teachers) {
  await limiter.acquire();
  processTeacher(teacher).finally(() => limiter.release());
}
```

**Location:** Agent main execution loop (P3)

---

### 4. **Incomplete Orphan Tab Handling**

**Problem:** Orphaned tabs (courses removed from Drive) are renamed to `🗑 <name>` but never actually removed from sync-state, causing them to reappear in every `--list-changes` report.

**Impact:**
- Confusing reports showing same orphans repeatedly
- sync-state file grows indefinitely with deleted courses

**Fix Required:**

```javascript
// In sync-state.js - Add cleanup option
function archiveOrphan(state, courseId, archiveMode = 'mark') {
  const entry = state.tabs[courseId];
  if (!entry) return;
  
  if (archiveMode === 'mark') {
    // Keep in state but mark as archived
    entry.archived = true;
    entry.archivedAt = new Date().toISOString();
  } else if (archiveMode === 'remove') {
    // Remove from state entirely
    delete state.tabs[courseId];
  }
}

// In render.js - Add --clean-orphans flag
if (opts.cleanOrphans) {
  for (const orphan of orphans) {
    archiveOrphan(state, orphan.courseId, 'remove');
  }
}
```

**Location:** `tool/sync-state.js`, `tool/render.js`

---

## 🟡 HIGH PRIORITY (Should Fix Before Scale)

### 5. **No Progress Tracking for Long Operations**

**Problem:** When crawling large teacher folders (30+ courses, 1000+ files), no progress indication. User doesn't know if process is stuck or working.

**Fix Required:**

```javascript
// Add progress bar
const cliProgress = require('cli-progress');
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

// In crawl.js
bar.start(courses.length, 0);
for (let i = 0; i < courses.length; i++) {
  await crawlCourse(courses[i]);
  bar.update(i + 1);
}
bar.stop();
```

**Location:** `tool/crawl.js`, `tool/render.js`

---

### 6. **Schema Validation Missing**

**Problem:** No validation that `schemas/<id>.json` files are well-formed. Malformed schema causes cryptic errors during render.

**Fix Required:**

```javascript
// In infer-schema.js
function validateSchema(schema) {
  const errors = [];
  if (!schema.levels || !Array.isArray(schema.levels)) {
    errors.push('Missing or invalid "levels" array');
  }
  for (const level of schema.levels || []) {
    if (typeof level.depth !== 'number') errors.push(`Level missing depth: ${JSON.stringify(level)}`);
    if (!level.label) errors.push(`Level missing label: ${JSON.stringify(level)}`);
  }
  if (!schema.leafFallback) errors.push('Missing "leafFallback"');
  if (!schema.courseRow) errors.push('Missing "courseRow"');
  
  if (errors.length > 0) {
    throw new Error(`Schema validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return true;
}

// Call before using schema
const schema = loadCachedSchema(teacherId);
validateSchema(schema.schema);
```

**Location:** `tool/infer-schema.js`

---

### 7. **Lesson Name Collision Detection Missing**

**Problem:** When two lessons have identical names (after cleaning), user-edit preservation maps to wrong lesson. No warning issued.

**Fix Required:**

```javascript
// In render.js - Detect collisions
function detectLessonNameCollisions(courseNode) {
  const nameCount = new Map();
  const collisions = [];
  
  function visit(n, depth) {
    const isLeaf = !n.children || n.children.length === 0;
    if (depth >= 1 && isLeaf) {
      const cleaned = cleanLessonName(n.name);
      nameCount.set(cleaned, (nameCount.get(cleaned) || 0) + 1);
      if (nameCount.get(cleaned) > 1) {
        collisions.push({ name: cleaned, id: n.id });
      }
    }
    for (const c of n.children || []) visit(c, depth + 1);
  }
  for (const top of courseNode.children || []) visit(top, 0);
  
  if (collisions.length > 0) {
    console.warn(`  ⚠ Lesson name collisions detected (user-edit may map incorrectly):`);
    collisions.forEach(c => console.warn(`    - "${c.name}" (${c.id})`));
  }
  return collisions;
}
```

**Location:** `tool/render.js` before `snapshotUserEdits()`

---

### 8. **No Dry-Run Validation for --sync Mode**

**Problem:** `--list-changes` shows plan but doesn't validate that user-edits will be preserved correctly. Users must trust the preview.

**Fix Required:**

```javascript
// Add --validate flag that does full dry-run with user-edit check
if (opts.validate) {
  console.log('\n🔍 VALIDATION MODE (dry-run with user-edit check):\n');
  for (const course of coursesToRender) {
    const snapshot = await snapshotUserEdits(sheets, ssId, course.tabName, course.node);
    console.log(`  ${course.tabName}: ${snapshot.size} user-edits found`);
    const collisions = detectLessonNameCollisions(course.node);
    if (collisions.length > 0) {
      console.error(`  ❌ COLLISION RISK: ${collisions.length} duplicate lesson names`);
    }
  }
  console.log('\nValidation complete. Run with --sync to apply.\n');
  process.exit(0);
}
```

**Location:** `tool/render.js`

---

## 🟢 MEDIUM PRIORITY (Nice to Have)

### 9. **Improve Agent Spec Clarity**

**Problem:** The 1175-line spec mixes implementation details with agent instructions. Hard to maintain.

**Recommendation:** Split into:
- `AGENT-INSTRUCTIONS.md` (what agent should do)
- `IMPLEMENTATION-REFERENCE.md` (how tool/ backend works)
- `TROUBLESHOOTING.md` (common issues + fixes)

---

### 10. **Add Smoke Test Suite**

**Problem:** No automated tests to verify pipeline works before deploying to production teachers.

**Fix Required:**

```javascript
// tool/test-smoke.js
async function smokeTest() {
  console.log('🧪 Running smoke tests...\n');
  
  // Test 1: Auth works
  const { drive, sheets } = await getClients();
  console.log('✓ Auth successful');
  
  // Test 2: Can read test teacher folder
  const testTeacherId = '1iCFcweKj...'; // Thầy Ái (already tested)
  const tree = await loadCachedTree(testTeacherId);
  assert(tree && tree.courses.length > 0, 'Tree cache missing');
  console.log(`✓ Tree cache valid (${tree.courses.length} courses)`);
  
  // Test 3: Schema loads
  const schema = loadCachedSchema(testTeacherId);
  validateSchema(schema.schema);
  console.log('✓ Schema valid');
  
  // Test 4: Dry-run render
  await renderTeacher(testTeacherId, { dryRun: true });
  console.log('✓ Dry-run render successful');
  
  console.log('\n✅ All smoke tests passed\n');
}
```

**Location:** `tool/test-smoke.js`

---

### 11. **Add Rollback Capability**

**Problem:** If a batch render fails halfway, no way to rollback to previous state.

**Recommendation:** 
- Before each render, snapshot current sheet state to `backups/<teacherId>-<timestamp>.json`
- Add `--rollback <timestamp>` flag to restore from backup

---

### 12. **Improve Logging**

**Problem:** Console logs are mixed with progress output. Hard to debug failures post-mortem.

**Fix Required:**

```javascript
// Add structured logging
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Use throughout
logger.info('Starting render', { teacherId, mode: 'sync' });
logger.error('API call failed', { error: err.message, teacherId, courseId });
```

**Location:** All `tool/*.js` files

---

## 📋 AGENT SPEC IMPROVEMENTS

### 13. **Clarify Default Mode**

**Current:** Spec says "Default mode: DRY_RUN" but doesn't explain when to use each mode.

**Fix:**

```markdown
## EXECUTION MODES - DECISION TREE

When user says:                          → Use mode:
- "show me what would change"            → --list-changes
- "render teacher X"                     → --sync (incremental, safe)
- "render teacher X from scratch"        → (no --sync, full render)
- "force recrawl and render"             → --force-refresh --sync
- "test without writing"                 → --dry-run

**Default for production:** Always use `--sync` unless user explicitly asks for full render.
**Default for testing:** Always use `--list-changes` first, then `--sync` after user confirms.
```

---

### 14. **Add Failure Recovery Procedures**

**Add to spec:**

```markdown
## FAILURE RECOVERY

### Scenario 1: Render fails mid-batch (5/8 tabs written)
1. Check `sync-states/<id>.json` - shows which tabs succeeded
2. Re-run with `--sync` - will skip successful tabs, retry failed ones
3. If still failing, check logs for specific error

### Scenario 2: User-edits lost after render
1. Check if `--no-preserve` was accidentally used
2. If not, check for lesson name collisions: `node render.js --teacher <id> --validate`
3. Restore from backup if available

### Scenario 3: API quota exceeded
1. Wait 1 minute for quota reset
2. Re-run with `--sync` to continue from checkpoint
3. Consider reducing concurrent operations (see rate limiter)

### Scenario 4: Schema detection wrong
1. Manually create `schemas/<id>.json` with correct structure
2. Re-run render - will use manual schema instead of auto-detect
```

---

### 15. **Add Pre-Flight Checklist**

**Add to spec:**

```markdown
## PRE-DEPLOYMENT CHECKLIST

Before running FULL mode on all 46 teachers:

- [ ] Run smoke test: `node tool/test-smoke.js`
- [ ] Test on 1 new teacher with `--list-changes` first
- [ ] Verify user-edit preservation: `--validate`
- [ ] Check API quota remaining (should have >10,000 calls available)
- [ ] Backup existing sheets (export to Drive folder)
- [ ] Set up error logging: `mkdir -p logs/`
- [ ] Review sync-states for any orphaned tabs: `ls tool/sync-states/`
- [ ] Confirm all schemas valid: `node tool/validate-all-schemas.js`
- [ ] Test rollback procedure on 1 teacher
- [ ] Notify users of maintenance window (if applicable)

**Estimated time for 46 teachers:** 
- Full crawl: ~30 min (if no cache)
- Incremental sync: ~5-10 min (typical daily update)
- Full render: ~45 min (first time only)
```

---

## 🎯 RECOMMENDED DEPLOYMENT STRATEGY

### Phase 1: Validation (Day 1)
1. Fix critical issues #1-4
2. Run smoke tests on 2 existing teachers
3. Test on 3 new teachers with `--list-changes` only

### Phase 2: Pilot (Day 2-3)
4. Deploy to 10 teachers with `--sync`
5. Monitor for 24 hours
6. Collect user feedback on data accuracy

### Phase 3: Scale (Day 4-5)
7. Deploy to remaining 36 teachers
8. Set up daily cron job for incremental sync
9. Document any teacher-specific quirks in schemas

### Phase 4: Maintenance (Ongoing)
10. Weekly review of orphaned tabs
11. Monthly schema validation
12. Quarterly backup verification

---

## 📊 SUCCESS METRICS

Track these metrics to validate deployment:

- **Data Integrity:** 0 user-edit losses (validate with spot checks)
- **Reliability:** <1% render failures (with auto-retry)
- **Performance:** <10 min for daily incremental sync (46 teachers)
- **User Satisfaction:** >90% accuracy on lesson/file mapping

---

## 🔧 QUICK FIXES (Can Do Now)

These can be implemented immediately without major refactoring:

1. **Add retry wrapper** (30 min) - Wrap all API calls in `withRetry()`
2. **Add progress bars** (15 min) - Install `cli-progress` and add to loops
3. **Add schema validation** (20 min) - Validate on load
4. **Add collision detection** (15 min) - Warn on duplicate lesson names
5. **Add --validate flag** (10 min) - Dry-run with user-edit check
6. **Create smoke test** (30 min) - Basic end-to-end test
7. **Improve logging** (20 min) - Add winston logger
8. **Update spec** (30 min) - Add decision tree, checklist, recovery procedures

**Total time:** ~3 hours to implement all quick fixes

---

## ✅ FINAL RECOMMENDATION

**DO NOT deploy to all 46 teachers until:**
1. ✅ Critical issues #1-4 are fixed
2. ✅ Smoke test passes on 3 new teachers
3. ✅ User-edit preservation validated with `--validate` flag
4. ✅ Rollback procedure tested

**Safe to deploy when:**
- All critical fixes implemented
- Pilot phase (10 teachers) successful for 24 hours
- Monitoring and logging in place

**Estimated timeline:** 1 week from fixes to full deployment
