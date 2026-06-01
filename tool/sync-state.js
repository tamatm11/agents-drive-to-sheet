// sync-state.js — Lưu trạng thái tab đã render để --sync mode chỉ xử lý tab mới/thay đổi.
//
// File: sync-states/<teacherFolderId>.json
// Format:
//   {
//     "updatedAt": "ISO",
//     "teacherId": "...",
//     "tabs": {
//       "<courseId>": {
//         "tabName": "Khóa TDMXX",
//         "renderedAt": "ISO",
//         "checksum": "<courseId>|<modifiedTime>|<fileCount>"
//       }
//     }
//   }
//
// Checksum = "<courseId>|<modifiedTime>|<totalFileCount>" — đủ để detect thay đổi
// mà không cần hash nặng. Nếu GV thêm/xóa file trong khóa → modifiedTime đổi → checksum đổi.

const fs = require('fs');
const path = require('path');
const {
  computeRenderableLessonChecksum,
  extractRenderableLessons,
} = require('./lesson-model');

const STATES_DIR = path.join(__dirname, 'sync-states');
const STATE_SCHEMA_VERSION = 3;
const DEFAULT_RENDERER_VERSION = 'unknown-renderer';
const DEFAULT_STYLE_VERSION = 'unknown-style';

function ensureDir() {
  if (!fs.existsSync(STATES_DIR)) fs.mkdirSync(STATES_DIR, { recursive: true });
}

function statePath(teacherFolderId) {
  return path.join(STATES_DIR, `${teacherFolderId}.json`);
}

function loadState(teacherFolderId) {
  const p = statePath(teacherFolderId);
  if (!fs.existsSync(p)) return { version: STATE_SCHEMA_VERSION, teacherId: teacherFolderId, tabs: {} };
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    state.version = state.version || 1;
    state.teacherId = state.teacherId || teacherFolderId;
    state.tabs = state.tabs || {};
    return state;
  } catch (_) {
    return { version: STATE_SCHEMA_VERSION, teacherId: teacherFolderId, tabs: {} };
  }
}

function saveState(teacherFolderId, state) {
  ensureDir();
  state.version = STATE_SCHEMA_VERSION;
  state.updatedAt = new Date().toISOString();
  state.teacherId = teacherFolderId;
  const p = statePath(teacherFolderId);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

function normalizeRunMeta(meta = {}) {
  return {
    rendererVersion: meta.rendererVersion || DEFAULT_RENDERER_VERSION,
    styleVersion: meta.styleVersion || DEFAULT_STYLE_VERSION,
    runId: meta.runId || '',
    spreadsheetId: meta.spreadsheetId || '',
  };
}

// Tính checksum từ course node trong tree.
// Đếm tổng file đệ quy + lấy modifiedTime mới nhất.
function computeChecksum(courseNode) {
  let fileCount = 0;
  let latestMod = courseNode.modifiedTime || '';

  function visit(node) {
    if (node.modifiedTime && node.modifiedTime > latestMod) latestMod = node.modifiedTime;
    fileCount += (node.files || []).length;
    for (const f of node.files || []) {
      if (f.modifiedTime && f.modifiedTime > latestMod) latestMod = f.modifiedTime;
    }
    for (const c of node.children || []) visit(c);
  }
  visit(courseNode);

  return `${courseNode.id}|${latestMod}|${fileCount}`;
}

// Tính checksum cho một lesson node (depth >= 1) bao gồm modifiedTime đệ quy
// và số file đệ quy. Dùng để diff lesson-level: biết bài nào mới/đổi/xóa.
function computeLessonChecksum(lessonNode) {
  return computeRenderableLessonChecksum(lessonNode);
}

// Trích danh sách lesson đúng với renderer, bao gồm cả virtual lessons
// materialized từ file-only assets như "Theme 10" nằm dưới CHAPTER.
function extractLessons(courseNode) {
  return extractRenderableLessons(courseNode);
}

// So sánh 2 danh sách lesson cũ vs mới → trả về { newLessons, changedLessons,
// removedLessons }. Mỗi item là { id, name } (lesson đã extract).
function diffLessons(prevLessons, currentLessons) {
  const prevMap = new Map((prevLessons || []).map((l) => [l.id, l]));
  const curMap = new Map((currentLessons || []).map((l) => [l.id, l]));
  const newLessons = [];
  const changedLessons = [];
  const removedLessons = [];
  for (const cur of currentLessons || []) {
    const prev = prevMap.get(cur.id);
    if (!prev) newLessons.push({ id: cur.id, name: cur.name });
    else if (prev.checksum !== cur.checksum) changedLessons.push({ id: cur.id, name: cur.name, prevChecksum: prev.checksum, newChecksum: cur.checksum });
  }
  for (const prev of prevLessons || []) {
    if (!curMap.has(prev.id)) removedLessons.push({ id: prev.id, name: prev.name });
  }
  return { newLessons, changedLessons, removedLessons };
}

// So sánh checksum hiện tại với state đã lưu.
// Trả về { action: 'skip'|'new'|'changed', reason, prevTabName, lessonDiff? }
// lessonDiff: { newLessons, changedLessons, removedLessons } khi state có
// lưu prevLessons để diff (giúp report chi tiết phiên sync).
function diffCourse(state, courseNode, newTabName, meta = {}) {
  const runMeta = normalizeRunMeta(meta);
  const prev = state.tabs && state.tabs[courseNode.id];
  const currentLessons = extractLessons(courseNode);
  if (prev && prev.archivedAt) return { action: 'new', reason: 'archived orphan restored', currentLessons };
  if (!prev) return { action: 'new', reason: 'chưa render lần nào', currentLessons };

  if (prev.styleVersion && prev.styleVersion !== runMeta.styleVersion) {
    return {
      action: 'changed',
      reason: `style ${prev.styleVersion} -> ${runMeta.styleVersion}`,
      prevTabName: prev.tabName,
      lessonDiff: { newLessons: [], changedLessons: [], removedLessons: [] },
      currentLessons,
    };
  }
  if (!prev.styleVersion && runMeta.styleVersion !== DEFAULT_STYLE_VERSION) {
    return {
      action: 'changed',
      reason: `bootstrap style ${runMeta.styleVersion}`,
      prevTabName: prev.tabName,
      lessonDiff: { newLessons: [], changedLessons: [], removedLessons: [] },
      currentLessons,
    };
  }

  const newChecksum = computeChecksum(courseNode);
  const courseChanged = prev.checksum !== newChecksum;

  // Nếu prev không có field `lessons` (state cũ trước migration) thì KHÔNG
  // dựa vào lessonDiff để quyết định — chỉ dùng course-level checksum.
  // Lần sync đầu tiên sau migration sẽ backfill field `lessons` silently
  // qua markRendered (tab nào không đổi vẫn trigger markRendered? — không,
  // markRendered chỉ chạy khi action != 'skip'). Để backfill an toàn,
  // syncMode caller có thể gọi markRendered cho tab skip nếu prev.lessons
  // missing (xem render.js).
  const hasPrevLessons = Array.isArray(prev.lessons);
  const lessonDiff = hasPrevLessons ? diffLessons(prev.lessons, currentLessons) : { newLessons: [], changedLessons: [], removedLessons: [] };
  const isLessonChanged = hasPrevLessons && (lessonDiff.newLessons.length + lessonDiff.changedLessons.length + lessonDiff.removedLessons.length > 0);

  if (courseChanged || isLessonChanged) {
    const reasons = [];
    if (lessonDiff.newLessons.length) reasons.push(`+${lessonDiff.newLessons.length} bài mới`);
    if (lessonDiff.changedLessons.length) reasons.push(`~${lessonDiff.changedLessons.length} bài đổi`);
    if (lessonDiff.removedLessons.length) reasons.push(`-${lessonDiff.removedLessons.length} bài xóa`);
    if (reasons.length === 0) {
      const oldFC = (prev.checksum || '').split('|')[2] || '?';
      const newFC = newChecksum.split('|')[2];
      reasons.push(`${oldFC} → ${newFC} file`);
    }
    return {
      action: 'changed',
      reason: reasons.join(', '),
      prevTabName: prev.tabName,
      lessonDiff,
      currentLessons,
    };
  }
  // Tab bị đổi tên (schema thay đổi) → cũng cần re-render
  if (prev.tabName && prev.tabName !== newTabName) {
    return {
      action: 'changed',
      reason: `tab đổi tên: "${prev.tabName}" → "${newTabName}"`,
      prevTabName: prev.tabName,
      lessonDiff,
      currentLessons,
    };
  }
  return {
    action: 'skip',
    reason: `không đổi từ ${(prev.renderedAt || '').slice(0, 10)}`,
    prevTabName: prev.tabName,
    currentLessons,
    needsBackfill: !hasPrevLessons,  // báo caller backfill lessons silently
  };
}

// Ghi kết quả render 1 tab vào state (kèm snapshot lessons để lần sau diff được).
function markRendered(state, courseNode, tabName, meta = {}) {
  const runMeta = normalizeRunMeta(meta);
  if (!state.tabs) state.tabs = {};
  state.tabs[courseNode.id] = {
    tabName,
    tabId: meta.tabId == null ? '' : meta.tabId,
    renderedAt: new Date().toISOString(),
    checksum: computeChecksum(courseNode),
    lessons: extractLessons(courseNode),
    rendererVersion: runMeta.rendererVersion,
    styleVersion: runMeta.styleVersion,
    runId: runMeta.runId,
    spreadsheetId: runMeta.spreadsheetId,
    stats: meta.stats || {},
  };
}

// Xóa entry của 1 course (khi tab bị xóa thủ công hoặc course bị remove khỏi Drive).
function markRemoved(state, courseId) {
  if (state.tabs) delete state.tabs[courseId];
}

function markArchived(state, courseId, archivedTabName, meta = {}) {
  if (!state.tabs || !state.tabs[courseId]) return null;
  const entry = state.tabs[courseId];
  entry.archivedAt = entry.archivedAt || new Date().toISOString();
  entry.archivedTabName = archivedTabName || entry.archivedTabName || entry.tabName;
  if (meta.tabId != null) entry.tabId = meta.tabId;
  if (meta.spreadsheetId) entry.spreadsheetId = meta.spreadsheetId;
  return entry;
}

// Lấy danh sách courseId đã render nhưng không còn trong tree hiện tại → tab orphan.
function findOrphanTabs(state, currentCourseIds, opts = {}) {
  const current = new Set(currentCourseIds);
  const orphans = [];
  for (const [id, entry] of Object.entries(state.tabs || {})) {
    if (entry.archivedAt && !opts.includeArchived) continue;
    if (!current.has(id)) orphans.push({ courseId: id, tabName: entry.tabName });
  }
  return orphans;
}

module.exports = {
  loadState,
  saveState,
  computeChecksum,
  computeLessonChecksum,
  extractLessons,
  diffLessons,
  diffCourse,
  markRendered,
  markRemoved,
  markArchived,
  findOrphanTabs,
  statePath,
  STATES_DIR,
  STATE_SCHEMA_VERSION,
};
