// utils.js — Shared utilities for error handling, retry logic, and validation

/**
 * Retry wrapper for API calls with exponential backoff.
 * Handles transient failures (429, 503) automatically.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} opts - Options
 * @param {number} opts.maxRetries - Max retry attempts (default: 3)
 * @param {number} opts.backoffMs - Initial backoff delay (default: 1000ms)
 * @param {string} opts.context - Context for logging (e.g., "crawl teacher X")
 * @returns {Promise<any>} Result of fn()
 */
async function withRetry(fn, opts = {}) {
  const { maxRetries = 3, backoffMs = 1000, context = 'API call' } = opts;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxRetries - 1;
      const code = err.code || err.status || (err.response && err.response.status);
      const isRetryable = code === 429
        || code === 500
        || code === 502
        || code === 503
        || code === 504
        || code === 'ECONNRESET'
        || code === 'ETIMEDOUT';

      if (isLastAttempt || !isRetryable) {
        console.error(`  ❌ ${context} failed after ${attempt + 1} attempts:`, err.message);
        throw err;
      }

      const jitter = Math.floor(Math.random() * 150);
      const delay = backoffMs * Math.pow(2, attempt) + jitter;
      console.log(`  ⚠ ${context} failed (${code}), retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Rate limiter for concurrent operations with quota tracking.
 * Prevents overwhelming API with too many concurrent requests.
 */
class RateLimiter {
  constructor(maxConcurrent = 3, quotaPerMinute = 100) {
    this.maxConcurrent = maxConcurrent;
    this.quotaPerMinute = quotaPerMinute;
    this.active = 0;
    this.callsThisMinute = 0;
    this.minuteStart = Date.now();
  }

  async acquire() {
    while (this.active >= this.maxConcurrent || this.callsThisMinute >= this.quotaPerMinute) {
      // Reset quota counter every minute
      if (Date.now() - this.minuteStart > 60000) {
        this.callsThisMinute = 0;
        this.minuteStart = Date.now();
      }
      await sleep(100);
    }
    this.active++;
    this.callsThisMinute++;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  getStats() {
    return {
      active: this.active,
      callsThisMinute: this.callsThisMinute,
      quotaRemaining: this.quotaPerMinute - this.callsThisMinute,
    };
  }
}

/**
 * Validate schema structure before using it.
 * Throws descriptive error if schema is malformed.
 */
function validateSchema(schema) {
  const errors = [];

  if (!schema) {
    throw new Error('Schema is null or undefined');
  }

  if (!schema.levels || !Array.isArray(schema.levels)) {
    errors.push('Missing or invalid "levels" array');
  } else {
    for (let i = 0; i < schema.levels.length; i++) {
      const level = schema.levels[i];
      if (typeof level.depth !== 'number') {
        errors.push(`Level ${i}: missing or invalid "depth" (expected number, got ${typeof level.depth})`);
      }
      if (!level.label || typeof level.label !== 'string') {
        errors.push(`Level ${i}: missing or invalid "label" (expected string)`);
      }
      if (level.icon && typeof level.icon !== 'string') {
        errors.push(`Level ${i}: invalid "icon" (expected string)`);
      }
    }
  }

  if (!schema.leafFallback || typeof schema.leafFallback !== 'object') {
    errors.push('Missing or invalid "leafFallback" object');
  }

  if (!schema.courseRow || typeof schema.courseRow !== 'object') {
    errors.push('Missing or invalid "courseRow" object');
  }

  if (errors.length > 0) {
    throw new Error(`Schema validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

/**
 * Detect lesson name collisions (multiple lessons with same cleaned name).
 * Returns array of collision groups.
 */
function detectLessonNameCollisions(courseNode, cleanNameFn) {
  const nameToLessons = new Map();

  function visit(node, depth) {
    const isLeaf = !node.children || node.children.length === 0;
    const looksLikeLesson = depth >= 1 && (isLeaf || /^TDM[A-Z]{2}\d|^[A-Z]{1,3}\d+[-–]/i.test(node.name || ''));

    if (looksLikeLesson) {
      const cleaned = cleanNameFn(node.name);
      if (!nameToLessons.has(cleaned)) {
        nameToLessons.set(cleaned, []);
      }
      nameToLessons.get(cleaned).push({ id: node.id, name: node.name });
      return; // Don't recurse into lessons
    }

    for (const child of node.children || []) {
      visit(child, depth + 1);
    }
  }

  for (const top of courseNode.children || []) {
    visit(top, 0);
  }

  // Return only names with collisions (count > 1)
  const collisions = [];
  for (const [cleanedName, lessons] of nameToLessons.entries()) {
    if (lessons.length > 1) {
      collisions.push({ cleanedName, lessons });
    }
  }

  return collisions;
}

/**
 * Validate that user edits were preserved correctly.
 * Returns stats about preservation success/failure.
 */
function validateUserEditRestore(beforeSnapshot, courseNode, findLessonByIdFn) {
  const stats = {
    total: beforeSnapshot.size,
    preserved: 0,
    lost: 0,
    lostLessons: [],
  };

  for (const [lessonId, edits] of beforeSnapshot.entries()) {
    const lessonNode = findLessonByIdFn(courseNode, lessonId);
    if (!lessonNode) {
      stats.lost++;
      stats.lostLessons.push({ id: lessonId, edits });
    } else {
      stats.preserved++;
    }
  }

  return stats;
}

/**
 * Simple sleep utility.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format timestamp for logging.
 */
function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Safe JSON stringify with error handling.
 */
function safeStringify(obj, indent = 2) {
  try {
    return JSON.stringify(obj, null, indent);
  } catch (err) {
    return `[Stringify Error: ${err.message}]`;
  }
}

module.exports = {
  withRetry,
  RateLimiter,
  validateSchema,
  detectLessonNameCollisions,
  validateUserEditRestore,
  sleep,
  timestamp,
  safeStringify,
};
