// Stage 3: Render Google Sheet từ trees/<id>.json + schemas/<id>.json
//
// CLI:
//   node render.js --teacher <folderId>            # đọc cache tree+schema
//   node render.js --teacher <folderId> --dry-run  # không ghi
//   node render.js --teacher <folderId> --max-videos 12
//   node render.js --teacher <folderId> --all-files
//
// Yêu cầu: chạy crawl.js trước, và có schemas/<id>.json (em sinh bằng tay).

const fs = require('fs');
const path = require('path');
const { getClients } = require('./auth');
const { listChildren } = require('./drive');
const { shortenTabName, appendTabNameSuffix, ensureTab, findSheetIdByTitle, renameTab, writeRichValues, readTabValues, hideColumn, verifyRenderedTab } = require('./sheet');
const { loadCachedTree, crawlTeacher, crawlTeacherIncremental } = require('./crawl');
const { loadCachedSchema } = require('./infer-schema');
const { loadState, saveState, diffCourse, markRendered, markRemoved, markArchived, findOrphanTabs } = require('./sync-state');
const { withRetry } = require('./utils');
const {
  buildVirtualLessonsForNode,
  shouldSplitFolderIntoVirtualLessons,
  isResourceContainer,
  isConcreteLessonNode,
  extractRenderableLessons,
} = require('./lesson-model');

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_MAX_VIDEOS = 8;
const VIDEO_MIME_PREFIX = 'video/';
const RENDERER_VERSION = '4.3.1';
const STYLE_VERSION = '2026-05-31-student-banner-no-meta-v2';
const LESSON_ID_HEADER = '_lesson_id';
// Nếu 1 folder chứa nhiều hơn ngưỡng này video → không list từng link video,
// chỉ list 1 link tới folder cha chứa các video đó (gọn cell, đỡ rối).
const VIDEO_COLLAPSE_THRESHOLD = 10;

function parseArgs(argv) {
  const out = { dryRun: false, maxVideos: DEFAULT_MAX_VIDEOS, allFiles: false, autoRefresh: true, syncMode: false, listChanges: false, preserveUserEdits: true, allowPreserveRisk: false, jsonSummary: false, verifyOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teacher' || a === '-t') out.teacherFolder = argv[++i];
    else if (a === '--sheet' || a === '-s') out.spreadsheetId = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--sync') out.syncMode = true;
    else if (a === '--list-changes') out.listChanges = true;
    else if (a === '--max-videos') out.maxVideos = parseInt(argv[++i], 10);
    else if (a === '--all-files') out.allFiles = true;
    else if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--no-auto-refresh') out.autoRefresh = false;
    else if (a === '--force-refresh') out.forceRefresh = true;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--no-skip-meta') process.env.RENDER_NO_SKIP_META = '1';
    else if (a === '--schema-v2') out.schemaV2Path = argv[++i];
    else if (a === '--no-preserve') out.preserveUserEdits = false;
    else if (a === '--allow-preserve-risk') out.allowPreserveRisk = true;
    else if (a === '--json-summary') out.jsonSummary = true;
    else if (a === '--verify-only') out.verifyOnly = true;
  }
  if (out.verifyOnly) {
    out.dryRun = true;
    out.autoRefresh = false;
  }
  return out;
}

// Load per-course schema-v2 (if any). Format:
//   { teacherId, teacherName, courses: [{ courseId, courseName, tabName, structure,
//     levels?, leafFallback?, courseRow?, notes? }], defaults?: { levels?, leafFallback?, courseRow? } }
// Returns null if path doesn't resolve.
function loadSchemaV2(givenPath, teacherFolderId) {
  const candidates = [];
  if (givenPath) candidates.push(givenPath);
  candidates.push(path.join(__dirname, 'schemas-v2', `${teacherFolderId}.json`));
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try { return { path: p, payload: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
      catch (e) { console.error(`  ⚠ Lỗi parse schema-v2 ${p}: ${e.message}`); }
    }
  }
  return null;
}

// Resolve per-course schema from schema-v2, falling back to defaults then legacy schema.
// Each course in schema-v2 may carry its own levels/leafFallback/courseRow; missing keys
// fall back to v2.defaults, then legacy schema. Returns the same shape buildCourseTab expects.
function resolveCourseSchemaV2(v2Payload, courseId, legacySchema) {
  const defaults = (v2Payload && v2Payload.defaults) || {};
  const cfg = (v2Payload && Array.isArray(v2Payload.courses))
    ? (v2Payload.courses.find((c) => c.courseId === courseId) || null)
    : null;
  const merged = {
    levels: (cfg && cfg.levels) || defaults.levels || legacySchema.levels || [],
    leafFallback: (cfg && cfg.leafFallback) || defaults.leafFallback || legacySchema.leafFallback,
    courseRow: (cfg && cfg.courseRow) || defaults.courseRow || legacySchema.courseRow,
    videoRow: (cfg && cfg.videoRow) || defaults.videoRow || legacySchema.videoRow,
    notes: (cfg && cfg.notes) || legacySchema.notes,
  };
  return { schema: merged, courseCfg: cfg };
}

// Sort numeric-aware: "10. Bài" sau "2. Bài" (KHÔNG dùng alphabet thuần).
// Trích số đầu tiên xuất hiện trong tên làm khóa chính, tie-break bằng localeCompare vi.
function sortKey(name) {
  const s = String(name || '');
  const m = /(\d+)/.exec(s);
  const num = m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
  return { num, lower: s.toLowerCase() };
}
function cmpNumeric(a, b) {
  const an = a && a.name !== undefined ? a.name : a;
  const bn = b && b.name !== undefined ? b.name : b;
  const ka = sortKey(an);
  const kb = sortKey(bn);
  if (ka.num !== kb.num) return ka.num - kb.num;
  return ka.lower.localeCompare(kb.lower, 'vi');
}
function sortTreeRecursive(node) {
  if (!node) return;
  if (Array.isArray(node.children) && node.children.length) {
    node.children.sort(cmpNumeric);
    node.children.forEach(sortTreeRecursive);
  }
  if (Array.isArray(node.files) && node.files.length) {
    node.files.sort(cmpNumeric);
  }
}

// Check Drive xem có thay đổi nào sau crawledAt không (rẻ: 1 API call list children cấp 1).
// Trả về:
//   {
//     changed: boolean,
//     reason: string,
//     changedCourseIds: string[],   // course có modifiedTime mới hơn cache
//     newCourseIds: string[],       // course mới (không có trong cache)
//     removedCourseIds: string[],   // course đã xóa khỏi Drive
//     teacherChanged: boolean       // folder gốc thay đổi (rename, ...)
//   }
//
// Granular hơn `changed: true/false` cũ — caller dùng để chỉ recrawl đúng
// những course đổi thay vì recrawl toàn bộ teacher.
async function detectDriveChange(drive, teacherFolderId, cachedTree) {
  const empty = { changed: false, reason: '', changedCourseIds: [], newCourseIds: [], removedCourseIds: [], teacherChanged: false };
  if (!cachedTree || !cachedTree.crawledAt) {
    return { ...empty, changed: true, reason: 'no cache' };
  }
  const crawledAt = new Date(cachedTree.crawledAt).getTime();
  const result = { ...empty };

  // Folder gốc giáo viên
  try {
    const meta = await withRetry(
      () => drive.files.get({ fileId: teacherFolderId, fields: 'modifiedTime' }),
      { context: `detect teacher modifiedTime ${teacherFolderId}` },
    );
    if (meta.data.modifiedTime && new Date(meta.data.modifiedTime).getTime() > crawledAt) {
      result.teacherChanged = true;
      result.reason = `teacher folder modified ${meta.data.modifiedTime}`;
    }
  } catch (_) { /* bỏ qua, fall through */ }

  // Children cấp 1 (khóa học)
  const kids = await listChildren(drive, teacherFolderId);
  const liveCourses = kids.filter((k) => k.mimeType === FOLDER_MIME);
  const cachedCourses = cachedTree.courses || [];
  const cachedById = new Map(cachedCourses.map((c) => [c.id, c]));
  const liveIds = new Set(liveCourses.map((c) => c.id));

  for (const c of liveCourses) {
    if (!cachedById.has(c.id)) {
      result.newCourseIds.push(c.id);
    } else if (c.modifiedTime) {
      const cachedMt = cachedById.get(c.id).modifiedTime || '';
      if (c.modifiedTime > cachedMt) result.changedCourseIds.push(c.id);
    }
  }
  for (const c of cachedCourses) {
    if (!liveIds.has(c.id)) result.removedCourseIds.push(c.id);
  }

  result.changed = result.teacherChanged
    || result.newCourseIds.length > 0
    || result.changedCourseIds.length > 0
    || result.removedCourseIds.length > 0;
  if (result.changed && !result.reason) {
    const parts = [];
    if (result.newCourseIds.length) parts.push(`${result.newCourseIds.length} khóa mới`);
    if (result.changedCourseIds.length) parts.push(`${result.changedCourseIds.length} khóa đổi`);
    if (result.removedCourseIds.length) parts.push(`${result.removedCourseIds.length} khóa xóa`);
    result.reason = parts.join(', ');
  }
  return result;
}

// Đọc tab cũ và snapshot user-edit (Trạng thái + Ghi chú) theo lesson name.
// Lý do dùng "lesson name" làm khóa thay vì lessonId:
//   - Sheet đang ở runtime không có cách native lưu lessonId vào row (rich
//     link tới folder thì có URL chứa folderId, dùng được làm anchor)
//   - Map text → status/note đủ để preserve trong 99% trường hợp (lesson
//     không trùng tên trong cùng 1 khóa)
//
// Trả về Map<lessonId, {status, note}>:
//   - Đọc cột "Tên" + parse Drive URL ra folderId nếu có → khóa lessonId
//   - Fallback: dùng name text (đã trim) làm khóa, gắn vào lessonId qua
//     courseTree để lookup ngược
async function snapshotUserEdits(sheets, spreadsheetId, tabName, courseNode) {
  const result = new Map();
  if (!tabName || !courseNode) return result;
  const sheetId = await findSheetIdByTitle(sheets, spreadsheetId, tabName);
  if (sheetId == null) return result;

  // Đọc dữ liệu thô (UNFORMATTED_VALUE — chỉ string text)
  const values = await readTabValues(sheets, spreadsheetId, tabName);
  if (!values || values.length < 2) return result;

  // Header để biết cột Trạng thái + Ghi chú nằm đâu (tab cũ có thể có header
  // khác, ví dụ thêm/bớt cột tài nguyên). Tìm theo label.
  const headerRowIndex = values.slice(0, 8).findIndex((candidate) => {
    const row = candidate || [];
    const hasName = row.some((h) => /^t[Ãªe]n/i.test(String(h || '').trim()));
    const hasUserCols = row.some((h) => /^tr[áº¡a]ng th[Ã¡a]i/i.test(String(h || '').trim()))
      || row.some((h) => /^ghi ch[Ãºu]/i.test(String(h || '').trim()));
    return hasName && hasUserCols;
  });
  const header = values[headerRowIndex >= 0 ? headerRowIndex : 0] || [];
  const idxName = header.findIndex((h) => /^t[êe]n/i.test(String(h || '').trim()));
  const idxStatus = header.findIndex((h) => /^tr[ạa]ng th[áa]i/i.test(String(h || '').trim()));
  const idxNote = header.findIndex((h) => /^ghi ch[úu]/i.test(String(h || '').trim()));
  if (idxName < 0 || (idxStatus < 0 && idxNote < 0)) return result;

  // Build map name (đã clean) → lessonId từ courseNode hiện tại (để khớp về id mới).
  const nameToId = new Map();
  for (const lesson of extractRenderableLessons(courseNode)) {
    const cleaned = cleanLessonName(lesson.name);
    if (cleaned) nameToId.set(cleaned, lesson.id);
  }

  // Đọc rows: với mỗi row có lesson name match nameToId → lưu user-edit
  for (let r = (headerRowIndex >= 0 ? headerRowIndex + 1 : 1); r < values.length; r++) {
    const row = values[r] || [];
    const rawName = String(row[idxName] || '');
    const cleaned = cleanLessonName(rawName);
    if (!cleaned) continue;
    const lessonId = nameToId.get(cleaned);
    if (!lessonId) continue;
    const status = idxStatus >= 0 ? String(row[idxStatus] || '').trim() : '';
    const note = idxNote >= 0 ? String(row[idxNote] || '').trim() : '';
    if (status || note) result.set(lessonId, { status, note });
  }
  return result;
}

// Strip indent + icon đầu để có tên lesson "core" để map.
// Vd: "      📂 T1-A1 – Nền tảng" → "T1-A1 – Nền tảng"
function normalizeHeaderLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function snapshotUserEditsDetailed(sheets, spreadsheetId, tabName, courseNode) {
  const edits = new Map();
  const diagnostics = {
    tabName,
    hasLessonIdColumn: false,
    usedLessonId: 0,
    usedNameFallback: 0,
    unmatchedRows: [],
    duplicateNameRows: [],
    blockingRisks: [],
    warnings: [],
  };
  if (!tabName || !courseNode) return { edits, diagnostics };
  const sheetId = await findSheetIdByTitle(sheets, spreadsheetId, tabName);
  if (sheetId == null) return { edits, diagnostics };

  const values = await readTabValues(sheets, spreadsheetId, tabName);
  if (!values || values.length < 2) return { edits, diagnostics };

  const headerRowIndex = values.slice(0, 8).findIndex((candidate) => {
    const row = candidate || [];
    const hasName = row.some((h) => normalizeHeaderLabel(h) === 'ten');
    const hasLessonId = row.some((h) => String(h || '').trim() === LESSON_ID_HEADER);
    const hasUserCols = row.some((h) => normalizeHeaderLabel(h).startsWith('trang thai'))
      || row.some((h) => normalizeHeaderLabel(h).startsWith('ghi chu'));
    return (hasName || hasLessonId) && hasUserCols;
  });
  const header = values[headerRowIndex >= 0 ? headerRowIndex : 0] || [];
  const idxName = header.findIndex((h) => normalizeHeaderLabel(h) === 'ten');
  const idxStatus = header.findIndex((h) => normalizeHeaderLabel(h).startsWith('trang thai'));
  const idxNote = header.findIndex((h) => normalizeHeaderLabel(h).startsWith('ghi chu'));
  const idxLessonId = header.findIndex((h) => String(h || '').trim() === LESSON_ID_HEADER);
  diagnostics.hasLessonIdColumn = idxLessonId >= 0;
  if ((idxName < 0 && idxLessonId < 0) || (idxStatus < 0 && idxNote < 0)) return { edits, diagnostics };

  const lessons = extractRenderableLessons(courseNode);
  const idSet = new Set(lessons.map((l) => l.id));
  const nameToIds = new Map();
  for (const lesson of lessons) {
    const cleaned = cleanLessonName(lesson.name);
    if (!cleaned) continue;
    if (!nameToIds.has(cleaned)) nameToIds.set(cleaned, []);
    nameToIds.get(cleaned).push(lesson.id);
  }

  for (let r = (headerRowIndex >= 0 ? headerRowIndex + 1 : 1); r < values.length; r++) {
    const row = values[r] || [];
    const status = idxStatus >= 0 ? String(row[idxStatus] || '').trim() : '';
    const note = idxNote >= 0 ? String(row[idxNote] || '').trim() : '';
    if (!status && !note) continue;

    const explicitId = idxLessonId >= 0 ? String(row[idxLessonId] || '').trim() : '';
    if (explicitId && idSet.has(explicitId)) {
      edits.set(explicitId, { status, note });
      diagnostics.usedLessonId++;
      continue;
    }

    const rawName = idxName >= 0 ? String(row[idxName] || '') : '';
    const cleaned = cleanLessonName(rawName);
    const ids = cleaned ? (nameToIds.get(cleaned) || []) : [];
    if (ids.length === 1) {
      edits.set(ids[0], { status, note });
      diagnostics.usedNameFallback++;
    } else if (ids.length > 1) {
      diagnostics.duplicateNameRows.push({ row: r + 1, name: cleaned, count: ids.length });
    } else {
      diagnostics.unmatchedRows.push({ row: r + 1, name: cleaned || rawName });
    }
  }

  if (!diagnostics.hasLessonIdColumn && diagnostics.usedNameFallback > 0) {
    diagnostics.warnings.push(`legacy preserve fallback used for ${diagnostics.usedNameFallback} edited row(s)`);
  }
  if (diagnostics.duplicateNameRows.length) {
    diagnostics.blockingRisks.push(`${diagnostics.duplicateNameRows.length} edited row(s) have duplicate lesson names`);
  }
  if (diagnostics.unmatchedRows.length) {
    diagnostics.blockingRisks.push(`${diagnostics.unmatchedRows.length} edited row(s) could not be matched to current lessons`);
  }
  return { edits, diagnostics };
}

function cleanLessonName(s) {
  return String(s || '')
    .replace(/^\s+/, '')
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function urlFolder(id) { return `https://drive.google.com/drive/folders/${id}`; }
function urlFile(id) { return `https://drive.google.com/file/d/${id}/view`; }
// Cell rich link: trả về object {text, link} để sheet.js writeRichValues ghi
// thành textFormatRuns + link.uri → Sheets nhận diện Drive URL → popup preview hover.
// (Trước đây dùng formula =HYPERLINK("url";"label") nhưng formula không trigger popup.)
function hyperlink(url, label) {
  return { text: String(label || ''), link: String(url || '') };
}

function emitJsonSummary(args, summary) {
  if (args && args.jsonSummary) {
    console.log(`JSON_SUMMARY ${JSON.stringify(summary)}`);
  }
}

// Rút gọn tên khóa thành tên tab ngắn gọn.
// Ví dụ:
//   "1. KHOÁ T NỀN TẢNG TOÁN 12"       → "Khóa T"
//   "2. KHOÁ E CHUYÊN ĐỀ CHUYÊN SÂU"   → "Khóa E"
//   "1. KHOÁ TDMXX 2027 ..."            → "Khóa TDMXX"
//   "1. KHOÁ CHUYÊN ĐỀ - Video + Live" → "Khóa Chuyên Đề"
//   "Khóa I Vận dụng ..."               → "Khóa I"
//   "1. LIVE I CHUYÊN ĐỀ CƠ BẢN"       → "LIVE I"
//   "1. STEP 1 2027 | Nền tảng Toán 12" → "STEP 1"
//   "CD8"                                → "CD8"
// Fallback: lấy 2 từ đầu sau số thứ tự.

// Viết hoa chữ cái đầu mỗi từ (Title Case) cho tiếng Việt.
function titleCaseVi(str) {
  return String(str || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function shortCourseLabel(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  // Bỏ số thứ tự đầu: "1. ", "2. ", "Z. "
  let noPrefix = cleaned.replace(/^[\dZ]+\.\s*/i, '');

  // Bỏ tag phân loại trong ngoặc vuông đầu tên, vd "[XPS TOÁN 12] KHOÁ NỀN TẢNG"
  // hay "[TOÁN 12] BỘ CÂU HỎI ...". Tag này thường GIỐNG nhau giữa nhiều khóa
  // cùng môn/lớp; phần phân biệt nằm SAU ngoặc. Chỉ bỏ khi còn nội dung mô tả.
  const mBracket = /^\[[^\]]*\]\s*(.+)$/.exec(noPrefix);
  if (mBracket && mBracket[1].trim()) {
    noPrefix = mBracket[1].trim();
  }

  // Pattern khóa: KHOÁ/KHÓA (cả chính tả cũ lẫn mới) + phần nhận diện.
  // "KHOÁ" (cũ: accent trên A) = KHO+Á → regex KHO[ÁA].
  // "KHÓA" (mới: accent trên O) = KH+Ó+A → regex KH[OÓ][AÁ].
  // Gộp: /^KH[OÓ][ÁA]\s+/i bắt cả hai dạng.
  const mKhoaPrefix = /^KH[OÓ][ÁA]\s+(.+)$/i.exec(noPrefix);
  if (mKhoaPrefix) {
    const rest = mKhoaPrefix[1].trim();
    // 1a) Mã chữ-số ngắn (T, E, I, TDMXX): "Khóa T", "Khóa I", "Khóa TDMXX".
    //     Mã = 1-6 ký tự chữ (kèm tùy chọn 1 số), đứng riêng 1 từ.
    const mCode = /^([A-Z]{1,6}\d?)(?=\s|$)/i.exec(rest);
    if (mCode) return `Khóa ${mCode[1].toUpperCase()}`;
    // 1b) Mã số La Mã: "Khóa I", "Khóa II", "Khóa III"
    const mRoman = /^(I{1,3}|IV|V|VI{0,3}|IX|X)(?=\s|$)/i.exec(rest);
    if (mRoman) return `Khóa ${mRoman[1].toUpperCase()}`;
    // 1c) Tên mô tả (CHUYÊN ĐỀ, VẬN DỤNG ...): cắt bỏ phần đuôi sau dấu
    //     phân tách. Dấu gạch nối (-/–) CHỈ cắt khi có khoảng trắng bao quanh
    //     (tránh tách "ZOOM-H", "V-ACT"). Dấu |, : cắt luôn.
    //     Title Case 3 từ đầu.
    const head = rest.split(/\s[-–]\s|[|:]/)[0].trim();
    const words = head.split(/\s+/).slice(0, 3).join(' ');
    return `Khóa ${titleCaseVi(words)}`;
  }

  // Pattern 2: LIVE + mã (chữ hoặc số), vd "LIVE I", "LIVE M"
  const mLive = /^LIVE\s+([A-Z\d]{1,4})\b/i.exec(noPrefix);
  if (mLive) return `LIVE ${mLive[1].toUpperCase()}`;

  // Pattern 2b: LIVE/Live + dấu phân tách + tên môn (vd "Live - Địa lí 12 - Khóa 2K9...")
  // Khi không có mã ngắn sau LIVE, lấy 3 từ đầu phần mô tả.
  const mLiveDesc = /^LIVE\s*[-–]\s*/i.exec(noPrefix);
  if (mLiveDesc) {
    const rest = noPrefix.slice(mLiveDesc[0].length).split(/\s[-–]\s|[|:]/)[0].trim();
    const label = rest.split(/\s+/).slice(0, 3).join(' ');
    return `Live ${label}`;
  }

  // Pattern 3: STEP + số
  const mStep = /^STEP\s+(\d{1,2})\b/i.exec(noPrefix);
  if (mStep) return `STEP ${mStep[1]}`;

  // Pattern 4: VOD + tên ngắn (lấy 3 từ đầu, cắt đuôi sau dấu phân tách)
  // Tiêu thụ cả dấu phân tách ngay sau VOD nếu có (vd "VOD - Địa lí 12")
  const mVod = /^VOD\s*[-–]?\s*/i.exec(noPrefix);
  if (mVod && mVod[0].length < noPrefix.length) {
    const rest = noPrefix.slice(mVod[0].length).split(/\s[-–]\s|[|:]/)[0].trim();
    return `VOD ${rest.split(/\s+/).slice(0, 3).join(' ')}`;
  }

  // Pattern 5: lộ trình theo Giai đoạn / Tháng "GĐ1.T1: LỘ TRÌNH..." → "GĐ1.T1"
  //   (đồng nhất cho cả tên có/không dấu ":" sau mã tháng, vd "GĐ1.T5 LỘ TRÌNH").
  const mPhase = /^(GĐ\s*\d+)\s*[.\-]?\s*(T\s*\d+)/i.exec(noPrefix);
  if (mPhase) {
    return `${mPhase[1].replace(/\s+/g, '')}.${mPhase[2].replace(/\s+/g, '')}`.toUpperCase();
  }

  // Pattern 6: ZOOM-X hoặc ZOOM X (mã 1-4 ký tự sau dấu gạch nối hoặc khoảng trắng)
  const mZoom = /^ZOOM[-\s]([A-Z\d]{1,4})\b/i.exec(noPrefix);
  if (mZoom) return `ZOOM-${mZoom[1].toUpperCase()}`;

  // Fallback: cắt phần đuôi sau dấu phân tách. Dấu gạch nối (-/–) CHỈ cắt khi có
  // khoảng trắng bao quanh (tránh tách "V-ACT", "ZOOM-H"). Dấu |, :, / cắt luôn.
  // Lấy 3 từ đầu — GIỮ token số phân biệt ngay sau nếu có (vd "VẬT LÝ 12 (2027)").
  const head = noPrefix.split(/\s[-–]\s|[|:/]/)[0].trim() || noPrefix;
  const tokens = head.split(/\s+/);
  const base = tokens.slice(0, 3);
  const next = tokens[3];
  if (next && /^\d{1,4}$/.test(next)) base.push(next);
  const words = base.join(' ');
  return words || noPrefix;
}

// Lấy `words` từ đầu phần mô tả của tên khóa (bỏ số thứ tự + tag [..]).
// Dùng để "nới" nhãn khi nhiều khóa trùng nhãn ngắn (vd 2 khóa "BONUS 2K8 ...").
function expandLabelFromName(name, words) {
  let s = String(name || '').replace(/\s+/g, ' ').trim().replace(/^[\dZ]+\.\s*/i, '');
  const mB = /^\[[^\]]*\]\s*(.+)$/.exec(s);
  if (mB && mB[1].trim()) s = mB[1].trim();
  const head = (s.split(/\s[-–]\s|[|:]/)[0].trim() || s);
  return head.split(/\s+/).slice(0, words).join(' ');
}

// Khóa chuẩn hóa để so trùng tab name. Google Sheets ép tên tab DUY NHẤT theo
// kiểu KHÔNG phân biệt hoa/thường, nên phải so theo lowercase (sau khi gọn space)
// — nếu không, "Khóa T" và "KHÓA T" lọt qua dedup nhưng đụng nhau ở ensureTab.
function tabKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// ĐẢM BẢO TRIỆT ĐỂ: mỗi khóa trong 1 lần render LUÔN có 1 tab name DUY NHẤT
// (không phân biệt hoa/thường), nên KHÔNG bao giờ mất khóa vì trùng tên tab.
//   B1) thử NỚI nhãn — lấy thêm từ trong tên khóa (3..7 từ) cho tới khi cả nhóm
//       trùng phân biệt được (giữ nhãn có nghĩa thay vì "(2)").
//   B2) nếu vẫn trùng (kể cả trùng chéo nhóm khác, hay tên thật giống hệt) →
//       thêm hậu tố " (2)/(3)"… cho tới khi duy nhất.
//   B3) hậu kiểm: nếu vì lý do nào đó vẫn còn trùng → ném lỗi to (fail loud),
//       thà dừng còn hơn âm thầm mất tab.
// Khóa có tabName chỉ định sẵn trong schema-v2 (courseCfg.tabName) KHÔNG bị nới
// (giữ nguyên ý đồ cấu hình), nhưng vẫn được B2 gắn hậu tố nếu lỡ trùng.
// Ổn định giữa các lần chạy vì thứ tự courses từ crawl là cố định.
function dedupeTabNames(plan, shortenFn, prefix = '') {
  // B1: gom theo nhãn hiện tại (case-insensitive), nới nhãn cho từng nhóm trùng.
  const groups = new Map(); // key chuẩn hóa -> [items]
  for (const p of plan) {
    const k = tabKey(p.tabName);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const items of groups.values()) {
    if (items.length <= 1) continue;
    const fixedKeys = new Set(items
      .filter((p) => p.courseCfg && p.courseCfg.tabName)
      .map((p) => tabKey(p.tabName)));
    const expandable = items.filter((p) => !(p.courseCfg && p.courseCfg.tabName));
    if (!expandable.length) continue;
    for (let wc = 3; wc <= 7; wc++) {
      const labels = expandable.map((p) => shortenFn(prefix + expandLabelFromName(p.course.name, wc), 99));
      const labelKeys = labels.map(tabKey);
      if (new Set(labelKeys).size === expandable.length && labelKeys.every((k) => !fixedKeys.has(k))) {
        expandable.forEach((p, i) => { p.tabName = labels[i]; });
        break;
      }
    }
  }

  // B2: đảm bảo duy nhất tuyệt đối (case-insensitive), xử lý cả trùng chéo nhóm.
  const seen = new Map(); // key chuẩn hóa -> số lần đã thấy
  for (const p of plan) {
    const original = p.tabName;
    let count = seen.get(tabKey(original)) || 0;
    if (count === 0) {
      seen.set(tabKey(original), 1);
      continue;
    }
    let candidate;
    do {
      count += 1;
      candidate = appendTabNameSuffix(original, `(${count})`, 99);
    } while (seen.has(tabKey(candidate)));
    seen.set(tabKey(original), count);
    seen.set(tabKey(candidate), 1);
    p.tabName = candidate;
  }

  // B3: hậu kiểm bất biến — không được còn 2 khóa nào trùng tab name.
  const check = new Map();
  for (const p of plan) {
    const k = tabKey(p.tabName);
    if (check.has(k)) {
      throw new Error(
        `[dedupeTabNames] BẤT BIẾN BỊ VI PHẠM: 2 khóa cùng tab "${p.tabName}" ` +
        `("${check.get(k)}" và "${p.course && p.course.name}"). Đây là bug logic dedup.`
      );
    }
    check.set(k, p.course && p.course.name);
  }
  return plan;
}
function isVideo(file) {
  return file && file.mimeType && file.mimeType.startsWith(VIDEO_MIME_PREFIX);
}
function pickMediaFiles(files, allFiles) {
  if (allFiles) return files.slice().sort(cmpNumeric);
  return files.filter(isVideo).sort(cmpNumeric);
}

// Phân loại 1 file theo pattern tên (đặc thù sheet thầy Ái và tương tự):
//   BG (Bài giảng video): "Bg01.*.mp4"
//   CHUA (Chữa đề video): "Chữa ĐTL/đề ... .mp4", "Live_Chữa"
//   DE (Đề tự luyện PDF): "ĐỀ TDMXX...A.pdf" / "ĐỀ ... .pdf"
//   KEY (Đáp án PDF): "KEY ĐỀ ... .pdf"
//   BVT (BVT_LIVE PDF / bảng viết tay): "BVT_LIVE_*.pdf" / "BVT_*.pdf"
//   FCD/FGC (File chinh dung / Final guide cốt lõi): "*_FCD_*.pdf", "*_FGC_*.pdf"
// Trả về { kind, part } với part ∈ {A, B, ''} suy từ tên file/ folder cha.
function classifyFile(file, parentFolderName) {
  const name = file.name || '';
  const upper = name.toUpperCase();
  const partFromParent = /(?:PHẦN|ĐỀ)\s*([AB])/i.exec(parentFolderName || '');
  const partFromName = /PHẦN[\s_]*([AB])|[_\s]([AB])(?:[._\s]|$)/i.exec(upper.replace(/.PDF|.MP4/i, ''));
  const part = (partFromParent && partFromParent[1]) || (partFromName && (partFromName[1] || partFromName[2])) || '';

  if (isVideo(file)) {
    if (/CH[ỮU]A|LIVE.*CH[ỮU]A/i.test(name)) return { kind: 'CHUA', part };
    return { kind: 'BG', part };
  }
  if (/^KEY\s/i.test(name) || /^KEY\b/i.test(upper)) return { kind: 'KEY', part };
  if (/^BVT_LIVE/i.test(name) || /^BVT_/i.test(name)) return { kind: 'BVT', part };
  if (/^ĐỀ\s/i.test(name) || /^DE\s/i.test(name) || /^ĐỀ$/i.test(name)) return { kind: 'DE', part };
  if (/_FCD_|_FGC_/i.test(name)) return { kind: 'GUIDE', part: '' };
  return { kind: 'OTHER', part: '' };
}

// Thu thập tất cả file trong subtree (descendant của lessonNode), nhóm theo kind.
// Mỗi item lưu thêm parentId/parentName (folder trực tiếp chứa file) để có thể
// gộp link về folder cha khi 1 folder chứa quá nhiều video.
function collectLessonAssets(node) {
  const buckets = { BG: [], CHUA: [], DE: [], KEY: [], BVT: [], GUIDE: [], OTHER: [] };
  let latest = node.modifiedTime || '';
  function visit(n, parentName) {
    if ((n.modifiedTime || '') > latest) latest = n.modifiedTime;
    for (const f of n.files || []) {
      if ((f.modifiedTime || '') > latest) latest = f.modifiedTime;
      const cls = classifyFile(f, f.__sourceParentName || parentName);
      (buckets[cls.kind] || buckets.OTHER).push({
        file: f,
        part: cls.part,
        parentId: n.id,
        parentName: n.name,
      });
    }
    for (const c of n.children || []) visit(c, n.name);
  }
  visit(node, node.name);
  return { buckets, latest };
}

// Trích số thứ tự "Bg01" / "Bg 02" → "Bg01"
function bgLabel(name) {
  const m = /Bg\s*0?(\d{1,2})/i.exec(name || '');
  if (m) return `Bg${m[1].padStart(2, '0')}`;
  return name.replace(/\.[^.]+$/, '').slice(0, 16);
}

// Sinh nhãn gọn theo kind. Khi có nhiều file cùng loại, hiển thị tên mô tả
// để học sinh biết nội dung từng video/file mà không cần click thử.
// idx: 1-based, total: tổng item cùng kind.
function shortLabelRaw(kind, file, part, idx, total) {
  if (kind === 'BG') {
    const name = file && file.name || '';
    // Nếu có nhiều video, trích phần mô tả từ tên file thay vì chỉ "Bg01"
    if (total && total > 1) {
      // Pattern: "Bg01. Khoảng cách cơ bản.mp4" → "Bg01. Khoảng cách cơ bản"
      const m = /Bg\s*0?(\d{1,2})[.\s]*(.+)/i.exec(name);
      if (m) {
        const num = m[1].padStart(2, '0');
        const desc = m[2].replace(/\.(mp4|avi|mkv|mov)$/i, '').trim();
        // Giới hạn độ dài để không làm cell quá rộng
        const shortDesc = desc.length > 45 ? desc.slice(0, 42) + '...' : desc;
        return `Bg${num}. ${shortDesc}`;
      }
      // Fallback: không match pattern Bg → dùng tên file gốc (bỏ extension)
      const cleanName = name.replace(/\.(mp4|avi|mkv|mov)$/i, '').trim();
      return cleanName.length > 45 ? cleanName.slice(0, 42) + '...' : cleanName;
    }
    // Chỉ 1 video → label ngắn gọn
    const m = /Bg\s*0?(\d{1,2})/i.exec(name);
    if (m) return `Bg${m[1].padStart(2, '0')}`;
    return 'Bài giảng';
  }
  if (kind === 'CHUA') {
    const name = file && file.name || '';
    if (total && total > 1) {
      // Nhiều video chữa đề → hiển thị tên mô tả để học sinh biết nội dung
      const cleanName = name.replace(/\.(mp4|avi|mkv|mov|pdf)$/i, '').replace(/^(CH[ỮU]A|LIVE.*CH[ỮU]A)[.\s_-]*/i, '').trim();
      if (cleanName && cleanName.length > 3) {
        const shortName = cleanName.length > 40 ? cleanName.slice(0, 37) + '...' : cleanName;
        return part ? `Chữa ${part}: ${shortName}` : `Chữa: ${shortName}`;
      }
    }
    if (part) return `Chữa ${part}`;
    if (total && total > 1) return `Chữa ${idx || 1}`;
    return 'Chữa đề';
  }
  if (kind === 'DE') {
    if (part) return `Đề ${part}`;
    if (total && total > 1) return `Đề ${idx || 1}`;
    return 'Đề';
  }
  if (kind === 'KEY') {
    if (part) return `Key ${part}`;
    if (total && total > 1) return `Key ${idx || 1}`;
    return 'Key';
  }
  if (kind === 'BVT') {
    const name = file && file.name || '';
    const m = /BVT[_\s]*(LIVE)?[_\s]*(\d+)?/i.exec(name);
    if (m && m[2]) return `BVT ${m[2]}`;
    if (total && total > 1) return `BVT ${idx || 1}`;
    return 'BVT';
  }
  if (kind === 'GUIDE') {
    const name = file && file.name || '';
    return /FGC/i.test(name) ? 'Guide FGC' : 'Guide FCD';
  }
  // OTHER: file PDF / tài liệu không match pattern nào → label ngắn gọn
  if (total && total > 1) return `Tài liệu ${idx || 1}`;
  return 'Tài liệu';
}

// Icon prefix per kind for instant visual scanning: video vs document.
//   BG / CHUA → ▶ (video)   ·   DE / KEY / BVT / GUIDE / OTHER → 📄 (PDF/doc)
const KIND_ICON = { BG: '▶', CHUA: '▶', DE: '📄', KEY: '📄', BVT: '📄', GUIDE: '📄', OTHER: '📄' };

// Public label = type icon + raw descriptive label. Keeps all existing
// labelling logic intact; just prefixes a glyph so students can tell video
// links from document links at a glance.
function shortLabel(kind, file, part, idx, total) {
  const raw = shortLabelRaw(kind, file, part, idx, total);
  const icon = KIND_ICON[kind] || '';
  return icon ? `${icon} ${raw}` : raw;
}

// 1 cell tài nguyên = 1 hyperlink chính + suffix "+N" nếu có nhiều file cùng kind.
//   - 0 file → ''
//   - 1 file → HYPERLINK(file, "Label")
//   - >1 → HYPERLINK(folderCha, "Label1 +N") (vào folder để xem hết các file còn lại)
function resourceCell(items, kind, fallbackFolderId) {
  if (!items || items.length === 0) return '';
  // Sort: theo part rồi theo name (numeric-aware)
  const sorted = items.slice().sort((a, b) => {
    const pa = a.part || 'Z', pb = b.part || 'Z';
    if (pa !== pb) return pa.localeCompare(pb);
    return cmpNumeric(a.file, b.file);
  });
  const first = sorted[0];
  const firstLabel = shortLabel(kind, first.file, first.part, 1, sorted.length);
  if (sorted.length === 1) {
    return hyperlink(urlFile(first.file.id), firstLabel);
  }
  // Nhiều file → gom nhãn nếu khác nhau (vd "Đề A,B"), link đến file đầu
  const allLabels = [...new Set(sorted.map((x, i) => shortLabel(kind, x.file, x.part, i + 1, sorted.length)))];
  if (allLabels.length <= 3 && allLabels.join('').length <= 18) {
    // Gom thành "Đề A,B" / "Bg01,Bg02,Bg03"
    const merged = allLabels.length === 1
      ? `${allLabels[0]} ×${sorted.length}`
      : allLabels.join(',');
    return hyperlink(urlFile(first.file.id), merged);
  }
  // Quá nhiều / quá dài → "Label1 +N" link tới folder chứa file đầu (fallback teacherFolder)
  const folderId = first.file.parents && first.file.parents[0] ? first.file.parents[0] : fallbackFolderId;
  return hyperlink(folderId ? urlFolder(folderId) : urlFile(first.file.id), `${firstLabel} +${sorted.length - 1}`);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return { red: 1, green: 1, blue: 1 };
  return {
    red: parseInt(m[1], 16) / 255,
    green: parseInt(m[2], 16) / 255,
    blue: parseInt(m[3], 16) / 255,
  };
}

// Centralized visual system for rendered Sheets. Keep formatting sub-fields
// explicit in repeatCell requests so rich-link textFormatRuns are preserved.
//
// Palette design (cohesive warm-navy theme):
//   - Header navy → course champagne → chapter warm-amber → sub-chapter cream
//     → lesson white/zebra → editable warm-yellow.
//   - Resource columns intentionally white (was pale-blue) so they don't
//     compete visually with the yellow editable columns.
//   - All level/course backgrounds are owned by render.js (UI_THEME); we
//     ignore the legacy `bg` field that lives in old hand-written schemas
//     because those colors (#FCE5C0, #FCF1D4, …) clash with the current look.
//     Schemas can still override icon/bold/fontSize.
const UI_THEME = {
  bannerBg: '#0B3D91',
  bannerText: '#FFFFFF',
  metaBg: '#E8F0FE',
  metaText: '#334155',
  headerBg: '#174EA6',           // Primary blue header band.
  headerText: '#FFFFFF',
  courseBg: '#D2E3FC',
  chapterBg: '#E8F0FE',
  subChapterBg: '#F3F8FF',
  sectionBg: '#F1F4F8',          // Cool light gray — depth 2+ (Phần/Tiết).
  lessonBg: '#FFFFFF',
  alternateLessonBg: '#F8FAFD',  // Subtle zebra.
  resourceBg: '#FFFFFF',         // Resource cells stay clean white.
  editableBg: '#FFF8E1',         // Soft yellow for student-owned cells.
  editableHeader: '#FEEFC3',
  gridBorder: '#DADCE0',
  strongBorder: '#A8B6C8',
  mutedText: '#64748B',
  linkBlue: '#1155CC',
  fontFamily: 'Arial',
};

// Status tracking config for the user-owned "Trạng thái" column.
// Values get a dropdown (data validation) + auto-color (conditional format)
// so the sheet works as a live progress tracker, not just free text.
const STATUS_OPTIONS = [
  { value: 'Chưa học',     bg: '#EAECEF', text: '#5F6B7A' }, // neutral gray
  { value: 'Đang học',     bg: '#D6E4FF', text: '#1F4E79' }, // blue
  { value: 'Đã xong',      bg: '#D4EDD4', text: '#1E6B2E' }, // green
  { value: 'Cần ôn lại',   bg: '#FCE3C0', text: '#9C5A12' }, // orange
];

// Data-validation dropdown on the Trạng thái column for real lesson rows only.
// rowRanges: array of {start, end} (0-based, end-exclusive) row spans to cover.
function addStatusValidation(reqs, sheetId, statusColIdx, rowRanges) {
  for (const { start, end } of rowRanges) {
    if (end <= start) continue;
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: start, endRowIndex: end, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: STATUS_OPTIONS.map((o) => ({ userEnteredValue: o.value })),
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
  }
}

// Conditional formatting: auto-color each status value across the whole status column.
// One TEXT_EQ rule per status. Applied sheet-wide on the status column so it
// survives re-render (rules are tied to sheetId, not cell values).
function addStatusConditionalFormat(reqs, sheetId, statusColIdx, rowCount, startRowIndex = 1) {
  STATUS_OPTIONS.forEach((opt, i) => {
    reqs.push({
      addConditionalFormatRule: {
        index: i,
        rule: {
          ranges: [{ sheetId, startRowIndex, endRowIndex: rowCount, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: opt.value }] },
            format: {
              backgroundColor: hexToRgb(opt.bg),
              textFormat: { foregroundColor: hexToRgb(opt.text), bold: true },
            },
          },
        },
      },
    });
  });
}

// Collapse a list of row indices into contiguous [start,end) ranges so we emit
// one setDataValidation request per run instead of one per row.
function toContiguousRanges(rowIndices) {
  const sorted = [...new Set(rowIndices)].sort((a, b) => a - b);
  const ranges = [];
  for (const r of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && r === last.end) last.end = r + 1;
    else ranges.push({ start: r, end: r + 1 });
  }
  return ranges;
}

// Delete all existing conditional-format rules on a sheet (highest index first
// to keep indices valid) so re-renders don't stack duplicate status-color rules.
async function clearConditionalFormats(sheets, spreadsheetId, sheetId) {
  try {
    const meta = await withRetry(
      () => sheets.spreadsheets.get({ spreadsheetId, includeGridData: false }),
      { context: `get conditional formats ${sheetId}` },
    );
    const sheet = (meta.data.sheets || []).find((s) => s.properties.sheetId === sheetId);
    const existing = (sheet && sheet.conditionalFormats) || [];
    if (!existing.length) return;
    const requests = [];
    for (let i = existing.length - 1; i >= 0; i--) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }
    await withRetry(
      () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
      { context: `clear conditional formats ${sheetId}` },
    );
  } catch (_) { /* best-effort cleanup */ }
}

// Choose the right level background based on depth.
function levelBgForDepth(depth) {  if (depth === 0) return UI_THEME.chapterBg;
  if (depth === 1) return UI_THEME.subChapterBg;
  return UI_THEME.sectionBg;
}

function formatLocalTimestamp(d = new Date()) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function tabColorForCourse(name) {
  const n = normalizeNameForFilter(name);
  if (/\btdmx\b|\bkhoa x\b/.test(n)) return '#174EA6';
  if (/\btdmy\b|\bkhoa y\b/.test(n)) return '#188038';
  if (/\btdmz\b|\bkhoa z\b/.test(n)) return '#E37400';
  if (/\btdmt\b|\bkhoa t\b/.test(n)) return '#7B1FA2';
  if (/\blive\b/.test(n)) return '#0B8043';
  if (/\bstep\b/.test(n)) return '#F9AB00';
  return '#174EA6';
}

function border(color, style = 'SOLID') {
  return { style, width: style === 'SOLID_MEDIUM' ? 2 : 1, color: hexToRgb(color) };
}

function addMerge(reqs, sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) {
  if (endRowIndex <= startRowIndex || endColumnIndex <= startColumnIndex) return;
  reqs.push({
    mergeCells: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
      mergeType: 'MERGE_ALL',
    },
  });
}

function addRowHeight(reqs, sheetId, rowIndex, pixelSize) {
  reqs.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  });
}

function cellText(cell) {
  if (cell && typeof cell === 'object' && typeof cell.text === 'string') return cell.text;
  return cell == null ? '' : String(cell);
}

function estimateTextLines(text, colPx) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 1;
  const charsPerLine = Math.max(8, Math.floor((colPx - 18) / 7));
  return raw.split(/\n+/).reduce((sum, part) => {
    return sum + Math.max(1, Math.ceil(part.length / charsPerLine));
  }, 0);
}

function estimateRowHeightPx(row, colWidths, kind) {
  if (!row || row.every((v) => !cellText(v))) return 12;
  let lines = 1;
  for (let c = 0; c < Math.min(row.length, colWidths.length); c++) {
    lines = Math.max(lines, estimateTextLines(cellText(row[c]), colWidths[c] || 120));
  }
  const base = 16 + lines * 18;
  const minByKind = {
    banner: 56,
    meta: 34,
    header: 42,
    course: 46,
    level: 40,
    lesson: 48,
    row: 34,
  }[kind || 'row'];
  const maxByKind = kind === 'header' || kind === 'banner' ? 90 : 190;
  return Math.max(minByKind, Math.min(maxByKind, base));
}

function addRangeBorders(reqs, sheetId, range, opts = {}) {
  const light = border(opts.light || UI_THEME.gridBorder);
  const strong = border(opts.strong || UI_THEME.strongBorder, opts.strongStyle || 'SOLID_MEDIUM');
  reqs.push({
    updateBorders: {
      range,
      top: opts.top || strong,
      bottom: opts.bottom || strong,
      left: opts.left || strong,
      right: opts.right || strong,
      innerHorizontal: opts.innerHorizontal || light,
      innerVertical: opts.innerVertical || light,
    },
  });
}

// Strip dấu tiếng Việt + lower + trim, để match tên "không-bài-học" không phụ thuộc dấu.
function normalizeNameForFilter(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Các khóa cấp 1 là folder "meta" (không phải bài học) → KHÔNG render thành tab.
// Match theo keyword phổ biến: INFO, THÔNG TIN, EBOOK, HƯỚNG DẪN, GIỚI THIỆU, LỘ TRÌNH, TÀI LIỆU KÈM, SÁCH KÈM.
// GIAI ĐOẠN: chỉ skip khi là grouping folder (có child sub-folders), không skip khi là course thực (H-SCA, SPT).
// LỘ TRÌNH: chỉ skip khi xuất hiện ở đầu tên ("0. Lộ trình học"), không skip khi ở giữa ("GĐ1.T1: LỘ TRÌNH HỌC THÁNG 1").
// Có thể bypass bằng env `RENDER_NO_SKIP_META=1` hoặc cờ `--no-skip-meta`.
const META_COURSE_PATTERNS = [
  /\binfo\b/,
  /\bthong tin\b/,
  /\bebook\b/,
  /\bsach kem\b/,
  /\bhuong dan\b/,
  /\bgioi thieu\b/,
  /\btai lieu kem\b/,
];
// Separate patterns with content-aware logic:
// "lo trinh" → only skip if at START of name (after optional "N." prefix)
const LO_TRINH_RE = /^(\d+[\.\s]+)?lo trinh\b/;
// "giai doan" → only skip if it's a grouping folder (has child sub-folders with content)
const GIAI_DOAN_RE = /\bgiai doan\b/;

function isMetaCourse(name, courseNode = null) {
  if (process.env.RENDER_NO_SKIP_META === '1') return false;
  const n = normalizeNameForFilter(name);

  // Basic keyword patterns (always skip when matched)
  if (META_COURSE_PATTERNS.some((re) => re.test(n))) return true;

  // "lo trinh": skip only if it appears at the START of the normalized name
  if (LO_TRINH_RE.test(n)) return true;
  if (/\blo trinh\b/.test(n) && !LO_TRINH_RE.test(n)) return false; // in middle → NOT meta

  // "giai doan": skip only if it's a GROUPING container (children are sub-courses with sub-folders).
  // Content courses named "GIAI ĐOẠN X" have children that are lesson folders containing only files.
  // Grouping containers have children that are sub-courses (with their own folder children).
  // Key: in the tree, folders have `children: [...]`, files do not have a `children` property.
  if (GIAI_DOAN_RE.test(n)) {
    if (courseNode === null) return true; // no info → default skip for safety
    const children = courseNode.children || [];
    // A grouping container's children have grandchildren that are also folders
    const hasSubCourses = children.some(c =>
      (c.children || []).some(gc => Array.isArray(gc.children))
    );
    return hasSubCourses;
  }

  return false;
}

async function findTeacherSpreadsheet(drive, teacherFolderId) {
  const kids = await listChildren(drive, teacherFolderId);
  const sheets = kids.filter((k) => k.mimeType === SHEET_MIME);
  if (sheets.length === 0) return null;
  sheets.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  return sheets[0];
}

// Pre-scan toàn bộ course tree để xác định file kinds nào thực sự tồn tại.
// Trả về Set of kind strings: 'BG', 'CHUA', 'DE', 'KEY', 'BVT', 'GUIDE', 'OTHER'
// Chỉ walk tree 1 lần, classify từng file trực tiếp (O(n), không dùng collectLessonAssets).
function scanCourseFileKinds(course) {
  const kinds = new Set();
  function visitFiles(node) {
    for (const f of node.files || []) {
      const cls = classifyFile(f, node.name);
      kinds.add(cls.kind);
    }
    for (const c of node.children || []) visitFiles(c);
  }
  for (const top of (course.children || [])) visitFiles(top);
  return kinds;
}

// Định nghĩa tất cả cột tài nguyên có thể có, theo thứ tự ưu tiên hiển thị.
// Mỗi entry: { key, label, kinds (set kind nào trigger cột này), width }
const ALL_RESOURCE_COLUMNS = [
  { key: 'BG',    label: 'Bài giảng',    kinds: ['BG'],               width: 190 },
  { key: 'DE',    label: 'Đề tự luyện',  kinds: ['DE'],               width: 155 },
  { key: 'KEY',   label: 'Check Key',    kinds: ['KEY'],              width: 145 },
  { key: 'CHUA',  label: 'Chữa đề',     kinds: ['CHUA'],             width: 165 },
  { key: 'BVT',   label: 'BVT / Khác',   kinds: ['BVT', 'GUIDE', 'OTHER'], width: 155 },
];

// Xây dựng danh sách cột động dựa trên kinds thực tế có trong course.
function buildDynamicColumns(presentKinds) {
  const cols = [];
  for (const col of ALL_RESOURCE_COLUMNS) {
    // Cột được include nếu BẤT KỲ kind nào trong col.kinds có mặt
    if (col.kinds.some((k) => presentKinds.has(k))) {
      cols.push(col);
    }
  }
  return cols;
}

// schema: { levels: [{ depth, label, icon, bold, bg }], leafFallback?, courseRow?, ... }
// opts: { maxVideos, allFiles, userEditByLessonId? }
//   userEditByLessonId: Map<lessonId, {status, note}> — giá trị user đã điền
//     ở phiên trước (đọc từ tab cũ). Render sẽ ghép lại đúng row của lesson.
function buildCourseTab(course, schema, opts) {
  const { maxVideos, allFiles } = opts;
  const userEditByLessonId = (opts && opts.userEditByLessonId) || new Map();

  // === DYNAMIC COLUMNS: scan course trước để biết cần cột nào ===
  const presentKinds = scanCourseFileKinds(course);
  const resourceCols = buildDynamicColumns(presentKinds);

  // Header = STT + Tên + [dynamic resource cols] + Cập nhật + Trạng thái + Ghi chú
  // Trạng thái + Ghi chú là 2 cột "user owned": render KHÔNG ghi đè giá trị
  // có sẵn (preserve qua snapshot tab cũ ở caller).
  const header = ['STT', 'Tên', ...resourceCols.map((c) => c.label), 'Cập nhật', 'Trạng thái', 'Ghi chú', LESSON_ID_HEADER];
  const NCOL = header.length;

  const bannerRow = [hyperlink(urlFolder(course.id), `📚 ${course.name}`), ...new Array(NCOL - 1).fill('')];
  const rows = [bannerRow, header];
  // Map lessonId → row index (1-based theo rows array) để patch user-edit sau khi build.
  const lessonRowByLessonId = new Map();
  const styles = { bannerRow: 0, metaRow: -1, headerRow: 1, courseRow: -1, levelRows: {}, lessonRows: [], lessonMergeRanges: [] };

  const courseStyle = schema.courseRow || { icon: '📚', bold: true, fontSize: 12, bg: '#D4E5FA' };

  const counters = {};
  let totalLeaves = 0;
  let totalVideos = 0;

  function getLevelCfg(depth) {
    const levels = schema.levels || [];
    if (depth < levels.length) return levels[depth];
    return levels[levels.length - 1] || { icon: '📁', bold: false, bg: '#F2F2F2' };
  }

  // Sinh mảng links cho 1 cột tài nguyên dựa trên key
  function buildColLinks(buckets, colKey) {
    const sortByName = (a, b) => cmpNumeric(a.file, b.file);
    const toLinks = (items, kind) => {
      const sorted = items.slice().sort(sortByName);
      return sorted.map((x, i) => hyperlink(urlFile(x.file.id), shortLabel(kind, x.file, x.part, i + 1, sorted.length)));
    };
    // Với cột video (BG/CHUA): gom theo folder cha. Folder nào chứa > ngưỡng
    // video thì KHÔNG list từng link video, chỉ tạo 1 link tới folder cha đó.
    // Folder ít video vẫn list link từng video như bình thường.
    const toVideoLinks = (items, kind) => {
      const groups = new Map(); // parentId → { parentId, parentName, items }
      for (const x of items) {
        const pid = x.parentId || node.id;
        if (!groups.has(pid)) groups.set(pid, { parentId: pid, parentName: x.parentName || '', items: [] });
        groups.get(pid).items.push(x);
      }
      const links = [];
      for (const g of groups.values()) {
        if (g.items.length > VIDEO_COLLAPSE_THRESHOLD) {
          const folderLabel = g.parentName
            ? `${g.parentName} (${g.items.length} video)`
            : `${g.items.length} video`;
          links.push(hyperlink(urlFolder(g.parentId), folderLabel));
        } else {
          const sorted = g.items.slice().sort(sortByName);
          for (let i = 0; i < sorted.length; i++) {
            links.push(hyperlink(urlFile(sorted[i].file.id), shortLabel(kind, sorted[i].file, sorted[i].part, i + 1, sorted.length)));
          }
        }
      }
      return links;
    };
    if (colKey === 'BG') return toVideoLinks(buckets.BG, 'BG');
    if (colKey === 'DE') return toLinks(buckets.DE, 'DE');
    if (colKey === 'KEY') return toLinks(buckets.KEY, 'KEY');
    if (colKey === 'CHUA') return toVideoLinks(buckets.CHUA, 'CHUA');
    if (colKey === 'BVT') {
      const bvtAll = [
        ...buckets.BVT.map((x) => ({ x, k: 'BVT' })),
        ...buckets.GUIDE.map((x) => ({ x, k: 'GUIDE' })),
        ...buckets.OTHER.map((x) => ({ x, k: 'OTHER' })),
      ];
      return bvtAll.map(({ x, k }, i) => hyperlink(urlFile(x.file.id), shortLabel(k, x.file, x.part, i + 1, bvtAll.length)));
    }
    return [];
  }

  function emitLessonRows(node, depth, stt, label, updatedStr) {
    const indent = '   '.repeat(depth);
    const { buckets, latest } = collectLessonAssets(node);
    if (latest) updatedStr = latest.slice(0, 10);
    totalLeaves++;
    totalVideos += buckets.BG.length + buckets.CHUA.length;
    const lessonStartRow = rows.length;
    styles.lessonRows.push(lessonStartRow);
    // Lưu mapping lessonId → row hiện tại (row đầu tiên của lesson, nơi đặt Trạng thái + Ghi chú)
    lessonRowByLessonId.set(node.id, lessonStartRow);

    // Build links cho từng cột dynamic
    const colLinksArr = resourceCols.map((col) => buildColLinks(buckets, col.key));
    const nRows = Math.max(1, ...colLinksArr.map((links) => links.length));

    // User-edit từ phiên trước: chỉ áp lên row đầu tiên của lesson
    const ue = userEditByLessonId.get(node.id) || { status: '', note: '' };

    for (let i = 0; i < nRows; i++) {
      // For sub-rows (i > 0), fill the Tên cell with the file name of the
      // first non-empty resource link in this row so the cell isn't blank.
      let subRowLabel = '';
      if (i > 0) {
        for (const links of colLinksArr) {
          const cell = links[i];
          if (cell && typeof cell === 'object' && cell.text) {
            subRowLabel = hyperlink(cell.link, `${indent}   ↳ ${cell.text}`);
            break;
          } else if (typeof cell === 'string' && cell) {
            subRowLabel = `${indent}   ↳ ${cell}`;
            break;
          }
        }
      }
      const row = [
        i === 0 ? stt : '',
        i === 0 ? label : subRowLabel,
        ...colLinksArr.map((links) => links[i] || ''),
        i === 0 ? updatedStr : '',
        i === 0 ? (ue.status || '') : '',
        i === 0 ? (ue.note || '') : '',
        i === 0 ? node.id : '',
      ];
      rows.push(row);
    }
    if (nRows > 1) styles.lessonMergeRanges.push({ start: lessonStartRow, end: lessonStartRow + nRows });
  }

  function emitVirtualLesson(lesson, depth) {
    const cfg = schema.leafFallback || getLevelCfg(depth);
    const indent = '   '.repeat(depth);
    const labelText = `${indent}${cfg.icon || ''} ${lesson.name}`;
    const label = hyperlink(lesson.webViewLink || urlFolder(lesson.virtualParentId), labelText);
    emitLessonRows(lesson, depth, '', label, (lesson.modifiedTime || '').slice(0, 10));
  }

  function emit(node, depth) {
    const children = node.children || [];
    const isLeaf = children.length === 0;
    const virtualLessons = buildVirtualLessonsForNode(node, depth);
    const splitVirtual = shouldSplitFolderIntoVirtualLessons(node, depth, virtualLessons);
    const hasDirectVideo = (node.files || []).some(isVideo);
    const cfg = isLeaf && schema.leafFallback && depth < (schema.levels || []).length - 1
      ? schema.leafFallback
      : getLevelCfg(depth);
    const indent = '   '.repeat(depth);
    counters[depth] = (counters[depth] || 0) + 1;

    const stt = depth === 0 ? counters[0] : '';
    const labelText = `${indent}${cfg.icon || ''} ${node.name}`;
    const label = hyperlink(node.webViewLink || urlFolder(node.id), labelText);

    const isLesson = !splitVirtual && (isConcreteLessonNode(node, depth) || hasDirectVideo);
    let updatedStr = (node.modifiedTime || '').slice(0, 10);

    (styles.levelRows[depth] = styles.levelRows[depth] || []).push({ row: rows.length, cfg });

    if (isLesson) {
      emitLessonRows(node, depth, stt, label, updatedStr);
    } else {
      const emptyRow = [stt, label, ...new Array(resourceCols.length).fill(''), updatedStr, '', '', ''];
      rows.push(emptyRow);
    }

    if (splitVirtual) {
      for (const lesson of virtualLessons) emitVirtualLesson(lesson, depth + 1);
    }

    if (!isLeaf && !isLesson) {
      counters[depth + 1] = 0;
      for (const child of children) {
        if (splitVirtual && isResourceContainer(child)) continue;
        emit(child, depth + 1);
      }
    }

    if (depth === 0) rows.push(new Array(NCOL).fill(''));
  }

  for (const top of course.children) emit(top, 0);

  if (course.children.length === 0) {
    const emptyRow = ['', '(Trống — chưa có bài học bên trong)'];
    while (emptyRow.length < NCOL) emptyRow.push('');
    rows.push(emptyRow);
  }

  // Column widths: STT + Tên + [dynamic resource cols] + Cập nhật + Trạng thái + Ghi chú.
  // Wider content columns plus dynamic row heights keep wrapped text visible.
  const colWidths = [54, 580, ...resourceCols.map((c) => Math.max(c.width, 145)), 118, 130, 320, 90];

  return {
    header,
    rows,
    leafCount: totalLeaves,
    totalVideos,
    NCOL,
    styles,
    courseStyle,
    colWidths,
    resourceCols,
    lessonRowByLessonId,
    courseName: course.name,
    tabColor: tabColorForCourse(course.name),
  };
}

async function applyTabFormatting(sheets, spreadsheetId, sheetId, built) {
  const reqs = [];
  const { styles, NCOL, rows, courseStyle } = built;
  const rowCount = Math.max(rows.length, 1);
  const bannerRow = styles.bannerRow ?? 0;
  const metaRow = styles.metaRow == null ? -1 : styles.metaRow;
  const headerRow = styles.headerRow ?? 0;
  const firstDataRow = headerRow + 1;

  // Existing sheets may already have frozen columns from older layouts. Banner
  // rows merge across every visible column, so unfreeze columns before merging.
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenColumnCount: 0 } },
      fields: 'gridProperties.frozenColumnCount',
    },
  });

  // Base table: readable font, middle alignment, clean grid border.
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: NCOL },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.lessonBg),
          textFormat: { fontFamily: UI_THEME.fontFamily, fontSize: 11 },
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
    },
  });
  addRangeBorders(reqs, sheetId, { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: NCOL });

  addMerge(reqs, sheetId, bannerRow, bannerRow + 1, 0, NCOL);
  if (metaRow >= 0) addMerge(reqs, sheetId, metaRow, metaRow + 1, 0, NCOL);
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: bannerRow, endRowIndex: bannerRow + 1, startColumnIndex: 0, endColumnIndex: NCOL },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.bannerBg),
          textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb(UI_THEME.bannerText), bold: true, fontSize: 16 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
    },
  });
  if (metaRow >= 0) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: metaRow, endRowIndex: metaRow + 1, startColumnIndex: 0, endColumnIndex: NCOL },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToRgb(UI_THEME.metaBg),
            textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb(UI_THEME.metaText), italic: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
          },
        },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
      },
    });
  }
  addRowHeight(reqs, sheetId, bannerRow, 56);
  if (metaRow >= 0) addRowHeight(reqs, sheetId, metaRow, 34);

  // Header
  reqs.push({
    repeatCell: {
        range: { sheetId, startRowIndex: headerRow, endRowIndex: headerRow + 1, startColumnIndex: 0, endColumnIndex: NCOL },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.headerBg),
          textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb(UI_THEME.headerText), bold: true, fontSize: 12 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
    },
  });
  addRowHeight(reqs, sheetId, headerRow, 40);
  addRangeBorders(reqs, sheetId, {
    sheetId,
    startRowIndex: headerRow,
    endRowIndex: headerRow + 1,
    startColumnIndex: 0,
    endColumnIndex: NCOL,
  }, { top: border(UI_THEME.headerBg, 'SOLID_MEDIUM'), bottom: border(UI_THEME.strongBorder, 'SOLID_MEDIUM') });

  // Freeze header row only. Some sheets have merged cells spanning multiple
  // columns which prevent freezing >1 column (API constraint). Frozen header
  // (1 row) alone is still very useful for scrolling through long lesson lists.
  // Future: could add frozenColumnCount dynamically once merged-cell detection is added.
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: firstDataRow, frozenColumnCount: 0 }, tabColor: hexToRgb(built.tabColor || UI_THEME.headerBg) },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColor',
    },
  });

  // Course row. Use centralized UI_THEME (legacy schema.bg ignored — too many
  // old schemas hard-coded peach/cream colors that clash with the navy theme).
  // Schema can still drive bold + fontSize.
  if (styles.courseRow >= 0) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: styles.courseRow, endRowIndex: styles.courseRow + 1, startColumnIndex: 0, endColumnIndex: NCOL },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToRgb(UI_THEME.courseBg),
            textFormat: { fontFamily: UI_THEME.fontFamily, bold: courseStyle.bold !== false, fontSize: Math.max(courseStyle.fontSize || 0, 16) },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment',
      },
    });
    addRowHeight(reqs, sheetId, styles.courseRow, 38);
    addRangeBorders(reqs, sheetId, {
      sheetId,
      startRowIndex: styles.courseRow,
      endRowIndex: styles.courseRow + 1,
      startColumnIndex: 0,
      endColumnIndex: NCOL,
    }, { top: border(UI_THEME.strongBorder, 'SOLID_MEDIUM'), bottom: border(UI_THEME.strongBorder, 'SOLID_MEDIUM') });
  }

  // Level rows (Chương / Bài / Phần). Background driven by depth via UI_THEME.
  const levelRowSet = new Set();
  for (const [depthStr, items] of Object.entries(styles.levelRows || {})) {
    const depth = parseInt(depthStr, 10) || 0;
    for (const { row, cfg } of items) {
      levelRowSet.add(row);
      const isChapter = depth === 0;
      const bg = levelBgForDepth(depth);
      // Graded font sizes per depth so parent folders read clearly larger than
      // their children: Chương 14 → Bài 12 → Phần+ 11.
      const levelFontSize = depth === 0 ? 14 : depth === 1 ? 12 : 11;
      reqs.push({
        repeatCell: {
          range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: NCOL },
          cell: {
            userEnteredFormat: {
              backgroundColor: hexToRgb(bg),
              textFormat: { fontFamily: UI_THEME.fontFamily, bold: !!cfg.bold, fontSize: levelFontSize },
              verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment',
        },
      });
      addRowHeight(reqs, sheetId, row, depth === 0 ? 38 : depth === 1 ? 32 : 30);
      addRangeBorders(reqs, sheetId, {
        sheetId,
        startRowIndex: row,
        endRowIndex: row + 1,
        startColumnIndex: 0,
        endColumnIndex: NCOL,
      }, { top: border(isChapter ? UI_THEME.strongBorder : UI_THEME.gridBorder, isChapter ? 'SOLID_MEDIUM' : 'SOLID') });
    }
  }

  // Lesson rows: zebra striping and comfortable height. Only color fixed
  // columns here; resource + user-owned columns get their own visual treatment below.
  const dateColIdx = NCOL - 4;
  const lessonRows = styles.lessonRows || [];
  lessonRows.forEach((row, i) => {
    const bg = i % 2 === 0 ? UI_THEME.lessonBg : UI_THEME.alternateLessonBg;
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: Math.min(2, NCOL) },
        cell: { userEnteredFormat: { backgroundColor: hexToRgb(bg) } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: dateColIdx, endColumnIndex: dateColIdx + 1 },
        cell: { userEnteredFormat: { backgroundColor: hexToRgb(bg) } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
    addRowHeight(reqs, sheetId, row, 46);
  });

  // Spacer rows after top-level sections.
  for (let r = firstDataRow; r < rowCount; r++) {
    const row = rows[r] || [];
    const isEmpty = row.every((v) => v === '' || v == null);
    if (isEmpty && !levelRowSet.has(r)) addRowHeight(reqs, sheetId, r, 12);
  }

  // Wrap and left-align lesson name + note-like text columns.
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: NCOL },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } },
      fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment',
    },
  });
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
      fields: 'userEnteredFormat.horizontalAlignment',
    },
  });

  // Column widths: dynamic from buildCourseTab.
  const colWidths = built.colWidths || [48, 460, 105, 120, 260];
  colWidths.forEach((px, i) => {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    });
  });

  // Final content-aware row heights. This intentionally runs after the older
  // baseline heights above so wrapped cells never clip long lesson/resource text.
  const lessonRowSet = new Set(lessonRows);
  for (let r = 0; r < rowCount; r++) {
    let kind = 'row';
    if (r === bannerRow) kind = 'banner';
    else if (r === metaRow) kind = 'meta';
    else if (r === headerRow) kind = 'header';
    else if (r === styles.courseRow) kind = 'course';
    else if (levelRowSet.has(r)) kind = 'level';
    else if (lessonRowSet.has(r)) kind = 'lesson';
    addRowHeight(reqs, sheetId, r, estimateRowHeightPx(rows[r] || [], colWidths, kind));
  }

  // Date format column.
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: dateColIdx, endColumnIndex: dateColIdx + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' }, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment',
    },
  });

  // Center align resource columns (clean white background — keeps the eye on
  // the link labels themselves rather than coloring noise).
  if (dateColIdx > 2) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: 2, endColumnIndex: dateColIdx },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', backgroundColor: hexToRgb(UI_THEME.resourceBg) } },
        fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.backgroundColor',
      },
    });
  }

  // User-owned columns: warm yellow so the user can see at a glance where
  // they're allowed to type. Header band uses a slightly stronger yellow.
  const statusColIdx = NCOL - 3;
  const noteColIdx = NCOL - 2;
  const lessonIdColIdx = NCOL - 1;
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: headerRow, endRowIndex: headerRow + 1, startColumnIndex: statusColIdx, endColumnIndex: noteColIdx + 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.editableHeader),
          textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb('#3A2E00'), bold: true, fontSize: 12 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment',
    },
  });
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 },
      cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', backgroundColor: hexToRgb(UI_THEME.editableBg) } },
      fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.backgroundColor',
    },
  });
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: noteColIdx, endColumnIndex: noteColIdx + 1 },
      cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', backgroundColor: hexToRgb(UI_THEME.editableBg), wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.backgroundColor,userEnteredFormat.wrapStrategy',
    },
  });
  addRangeBorders(reqs, sheetId, {
    sheetId,
    startRowIndex: headerRow,
    endRowIndex: rowCount,
    startColumnIndex: statusColIdx,
    endColumnIndex: noteColIdx + 1,
  }, { left: border(UI_THEME.strongBorder, 'SOLID_MEDIUM') });

  // === Interactive status tracking ===
  // 1) Clear any stale data-validation on the status column (range may shrink
  //    between renders), then re-apply dropdown only to real lesson rows.
  reqs.push({
    setDataValidation: {
      range: { sheetId, startRowIndex: firstDataRow, endRowIndex: rowCount, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 },
    },
  });
  const lessonRowRanges = toContiguousRanges(styles.lessonRows || []);
  addStatusValidation(reqs, sheetId, statusColIdx, lessonRowRanges);
  // 2) Conditional formatting (auto-color by status value). Stale rules are
  //    purged separately before this batch (see clearConditionalFormats).
  addStatusConditionalFormat(reqs, sheetId, statusColIdx, rowCount, firstDataRow);

  for (const span of styles.lessonMergeRanges || []) {
    if (!span || span.end - span.start < 2) continue;
    [0, 1, dateColIdx, statusColIdx, noteColIdx].forEach((col) => {
      addMerge(reqs, sheetId, span.start, span.end, col, col + 1);
    });
  }

  reqs.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: lessonIdColIdx, endIndex: lessonIdColIdx + 1 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  });

  // Purge existing conditional-format rules on this sheet so they don't
  // accumulate across re-renders, then run our formatting batch.
  await clearConditionalFormats(sheets, spreadsheetId, sheetId);

  // Batch in chunks to avoid oversized requests.
  const CHUNK = 60;
  for (let i = 0; i < reqs.length; i += CHUNK) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: reqs.slice(i, i + CHUNK) },
    }), { context: `apply tab formatting ${sheetId} chunk ${Math.floor(i / CHUNK) + 1}` });
  }
}

async function applyIndexFormatting(sheets, spreadsheetId, sheetId, rowCount) {
  const reqs = [];
  const NCOL = 6;
  const safeRows = Math.max(rowCount, 1);

  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: safeRows, startColumnIndex: 0, endColumnIndex: NCOL },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.lessonBg),
          textFormat: { fontFamily: UI_THEME.fontFamily, fontSize: 11 },
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
    },
  });
  addRangeBorders(reqs, sheetId, { sheetId, startRowIndex: 0, endRowIndex: safeRows, startColumnIndex: 0, endColumnIndex: NCOL });
  addMerge(reqs, sheetId, 0, 1, 0, NCOL);

  // Title and metadata area.
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: NCOL },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(UI_THEME.bannerBg),
          textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb(UI_THEME.bannerText), bold: true, fontSize: 16 },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment',
    },
  });
  addRowHeight(reqs, sheetId, 0, 42);

  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: Math.min(4, safeRows), startColumnIndex: 0, endColumnIndex: NCOL },
      cell: { userEnteredFormat: { backgroundColor: hexToRgb(UI_THEME.courseBg) } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  });

  // Header row at index 5.
  if (safeRows > 5) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: NCOL },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToRgb(UI_THEME.headerBg),
            textFormat: { fontFamily: UI_THEME.fontFamily, foregroundColor: hexToRgb(UI_THEME.headerText), bold: true, fontSize: 12 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment',
      },
    });
    addRowHeight(reqs, sheetId, 5, 36);
    addRangeBorders(reqs, sheetId, { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: NCOL }, { bottom: border(UI_THEME.strongBorder, 'SOLID_MEDIUM') });
  }

  // Data rows.
  for (let r = 6; r < safeRows; r++) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: NCOL },
        cell: { userEnteredFormat: { backgroundColor: hexToRgb((r - 6) % 2 === 0 ? UI_THEME.lessonBg : UI_THEME.alternateLessonBg) } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
    addRowHeight(reqs, sheetId, r, 34);
  }

  [55, 420, 120, 80, 80, 150].forEach((px, i) => {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    });
  });
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 6, frozenColumnCount: 0 }, tabColor: hexToRgb(UI_THEME.bannerBg) },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColor',
    },
  });

  const CHUNK = 60;
  for (let i = 0; i < reqs.length; i += CHUNK) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: reqs.slice(i, i + CHUNK) },
    }), { context: `apply index formatting ${sheetId} chunk ${Math.floor(i / CHUNK) + 1}` });
  }
}

function buildIndexRows(courseSummaries, teacherName, teacherFolderId, schema) {
  const header = ['STT', 'Khóa học (folder cấp 3)', 'Tab', 'Số bài', 'Số video', 'Link folder'];
  const rows = [
    [`TỔNG HỢP DANH SÁCH BÀI HỌC – ${teacherName}`, '', '', '', '', ''],
    [`Folder gốc giáo viên:`, hyperlink(urlFolder(teacherFolderId), 'Mở folder gốc'), '', '', '', ''],
    [`Cập nhật:`, new Date().toISOString().slice(0, 19).replace('T', ' '), '', '', '', ''],
    [`Schema:`, (schema && schema.notes) || '', '', '', '', ''],
    [],
    header,
  ];
  courseSummaries.forEach((c, i) => {
    rows.push([
      i + 1,
      c.courseName,
      c.tabName,
      c.leafCount,
      c.totalVideos,
      hyperlink(urlFolder(c.courseId), 'Mở folder khóa'),
    ]);
  });
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.teacherFolder) {
    console.error('Thiếu --teacher <folderId>');
    process.exit(1);
  }
  const prefix = args.prefix || '';

  let cachedTree = loadCachedTree(args.teacherFolder);
  if (!cachedTree) {
    console.error(`Chưa có tree cache. Chạy trước: node crawl.js --teacher ${args.teacherFolder}`);
    process.exit(1);
  }
  const schemaPayload = loadCachedSchema(args.teacherFolder);
  if (!schemaPayload) {
    console.error(`Chưa có schema. Nhờ Claude session sinh schemas/${args.teacherFolder}.json trước.`);
    process.exit(1);
  }
  const schema = schemaPayload.schema;

  // Per-course schema-v2 override (sinh từ subagent ai-sheet-structurer).
  // Khi có, mỗi khóa dùng config riêng (levels/leafFallback/courseRow/tabName).
  const v2Loaded = loadSchemaV2(args.schemaV2Path, args.teacherFolder);
  if (v2Loaded) {
    const ncourses = (v2Loaded.payload.courses || []).length;
    console.log(`Schema-v2: ${v2Loaded.path} (${ncourses} course override)`);
  }
  const v2Payload = v2Loaded ? v2Loaded.payload : null;

  const { drive, sheets } = getClients();
  const teacherName = cachedTree.teacher.name;
  console.log(`Giáo viên: ${teacherName}`);
  console.log(`Tree crawled: ${cachedTree.crawledAt}`);
  console.log(`Schema updated: ${schemaPayload.updatedAt}`);

  // Auto-detect Drive change → recrawl (trừ khi --no-auto-refresh).
  // --force-refresh thì bỏ qua check, recrawl luôn.
  // Dùng INCREMENTAL crawl khi có thể: chỉ walk lại course đã đổi, giữ nguyên
  // các course không thay đổi → tiết kiệm API call đáng kể.
  if (args.forceRefresh || args.autoRefresh) {
    let needRecrawl = !!args.forceRefresh;
    let reason = 'forced';
    let changedIds = null;
    let newIds = null;
    let removedIds = null;
    if (!needRecrawl) {
      try {
        const det = await detectDriveChange(drive, args.teacherFolder, cachedTree);
        needRecrawl = det.changed;
        reason = det.reason;
        changedIds = det.changedCourseIds;
        newIds = det.newCourseIds;
        removedIds = det.removedCourseIds;
      } catch (e) {
        if (/Preserve risk blocked/.test(e.message || '')) throw e;
        console.log(`  Cảnh báo: detectDriveChange thất bại (${e.message}) → bỏ qua check.`);
      }
    }
    if (needRecrawl) {
      console.log(`  Drive thay đổi (${reason}) → recrawl...`);
      if (removedIds && removedIds.length) {
        console.log(`    Khóa đã xóa khỏi Drive: ${removedIds.length} (sẽ archive tab tương ứng)`);
      }
      const onProgress = (p) => {
        if (p.phase === 'course-start') process.stdout.write(`    [${p.index + 1}/${p.total}] ${p.name}\n`);
      };
      if (args.forceRefresh || !changedIds) {
        // Full crawl: chưa có cache hoặc user ép --force-refresh
        cachedTree = await crawlTeacher(drive, args.teacherFolder, { force: true, onProgress });
      } else {
        // Incremental: chỉ walk các course đổi + course mới
        const onlyIds = [...(changedIds || []), ...(newIds || [])];
        if (onlyIds.length === 0) {
          // Chỉ removed → không cần walk gì, chỉ refresh metadata
          cachedTree = await crawlTeacherIncremental(drive, args.teacherFolder, [], { onProgress });
        } else {
          cachedTree = await crawlTeacherIncremental(drive, args.teacherFolder, onlyIds, { onProgress });
        }
      }
      console.log(`  ✓ Recrawl xong (${cachedTree.courses.length} khóa)`);
    } else {
      console.log(`  Drive không đổi từ ${cachedTree.crawledAt} → dùng cache.`);
    }
  }

  // Sort numeric-aware (course + chapter + lesson + file) trước khi build tab.
  cachedTree.courses.sort(cmpNumeric);
  cachedTree.courses.forEach(sortTreeRecursive);

  let spreadsheetId = args.spreadsheetId;
  if (!spreadsheetId) {
    const ss = await findTeacherSpreadsheet(drive, args.teacherFolder);
    if (!ss) throw new Error('Không tìm thấy spreadsheet trong folder giáo viên. Truyền --sheet <id>.');
    spreadsheetId = ss.id;
    console.log(`Sheet đích: ${ss.name}`);
    console.log(`  https://docs.google.com/spreadsheets/d/${ss.id}/edit`);
  }

  const allCourses = cachedTree.courses;
  // Skip các khóa không phải bài học thực (INFO, EBOOK, hướng dẫn, tài liệu kèm…)
  // Match theo tên (case-insensitive, bỏ dấu) thay vì hardcode ID.
  const courses = allCourses.filter((c) => !isMetaCourse(c.name, c));
  const skipped = allCourses.filter((c) => isMetaCourse(c.name, c));
  console.log(`Phát hiện ${allCourses.length} khóa → ${courses.length} render, ${skipped.length} skip`);
  if (skipped.length) {
    skipped.forEach((c) => console.log(`  ⊘ skip: ${c.name}`));
  }

  // Đảm bảo locale vi_VN cho HYPERLINK dùng dấu ; (KHÔNG phải ,)
  if (!args.dryRun && !args.listChanges) {
    const meta0 = await withRetry(
      () => sheets.spreadsheets.get({ spreadsheetId, includeGridData: false }),
      { context: `get spreadsheet locale ${spreadsheetId}` },
    );
    if (meta0.data.properties.locale !== 'vi_VN') {
      console.log(`  Locale: ${meta0.data.properties.locale} → vi_VN`);
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateSpreadsheetProperties: {
              properties: { locale: 'vi_VN', timeZone: 'Asia/Ho_Chi_Minh' },
              fields: 'locale,timeZone',
            },
          }],
        },
      }), { context: `set spreadsheet locale ${spreadsheetId}` });
    }
  }

  // Dọn tab cũ với prefix BÀI HỌC (chỉ khi KHÔNG dùng --sync)
  const oldPrefixes = ['BÀI HỌC - '];
  if (!args.dryRun && !args.syncMode && !args.listChanges) {
    const meta = await withRetry(
      () => sheets.spreadsheets.get({ spreadsheetId }),
      { context: `list old tabs ${spreadsheetId}` },
    );
    const toDelete = (meta.data.sheets || [])
      .filter((s) => oldPrefixes.some((p) => s.properties.title.startsWith(p)))
      .map((s) => s.properties.sheetId);
    if (toDelete.length) {
      console.log(`  Dọn ${toDelete.length} tab cũ`);
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: toDelete.map((id) => ({ deleteSheet: { sheetId: id } })) },
      }), { context: `delete old tabs ${spreadsheetId}` });
    }
  }

  // Load sync state (dùng cho --sync và --list-changes)
  const syncState = loadState(args.teacherFolder);
  const syncMode = args.syncMode || args.listChanges;
  const checkpointMeta = {
    rendererVersion: RENDERER_VERSION,
    styleVersion: STYLE_VERSION,
    runId: args.runId || '',
    spreadsheetId,
  };
  const runSummary = {
    teacherId: args.teacherFolder,
    teacherName,
    spreadsheetId,
    mode: args.verifyOnly ? 'verify-only' : args.listChanges ? 'list' : args.syncMode ? 'sync' : args.dryRun ? 'dry-run' : 'render',
    rendered: 0,
    skipped: 0,
    verified: 0,
    failed: 0,
    preserveRisks: [],
    tabs: [],
    orphans: [],
  };

  // Phân loại: new / changed / skip
  // Bước 1: gán tabName thô cho từng khóa.
  const plan = courses.map((c) => {
    const { schema: courseSchema, courseCfg } = resolveCourseSchemaV2(v2Payload, c.id, schema);
    const tabLabel = (courseCfg && courseCfg.tabName) || shortCourseLabel(c.name);
    const tabName = shortenTabName(prefix + tabLabel, 99);
    return { course: c, courseSchema, tabName, courseCfg };
  });
  // Bước 2: khử trùng tabName TRƯỚC khi tính diff (để diffCourse khớp đúng tab).
  dedupeTabNames(plan, shortenTabName, prefix);
  // Bước 3: tính diff với tabName đã là duy nhất.
  for (const p of plan) {
    p.diff = syncMode ? diffCourse(syncState, p.course, p.tabName, checkpointMeta) : { action: 'render' };
  }

  // --list-changes: chỉ in plan, không ghi
  if (args.listChanges) {
    console.log('\n📋 KẾ HOẠCH SYNC:');
    const newTabs = plan.filter((p) => p.diff.action === 'new');
    const changedTabs = plan.filter((p) => p.diff.action === 'changed');
    const skipTabs = plan.filter((p) => p.diff.action === 'skip');
    runSummary.skipped = skipTabs.length;
    if (newTabs.length) {
      console.log(`\n  🆕 Tab mới (${newTabs.length}):`);
      newTabs.forEach((p) => console.log(`    + "${p.tabName}" ← ${p.course.name}`));
    }
    if (changedTabs.length) {
      console.log(`\n  🔄 Tab thay đổi (${changedTabs.length}):`);
      changedTabs.forEach((p) => {
        console.log(`    ~ "${p.tabName}" — ${p.diff.reason}`);
        const ld = p.diff.lessonDiff;
        if (ld) {
          if (ld.newLessons.length) {
            console.log(`        + bài mới: ${ld.newLessons.slice(0, 5).map((l) => l.name).join(', ')}${ld.newLessons.length > 5 ? ` … (+${ld.newLessons.length - 5})` : ''}`);
          }
          if (ld.changedLessons.length) {
            console.log(`        ~ bài đổi: ${ld.changedLessons.slice(0, 5).map((l) => l.name).join(', ')}${ld.changedLessons.length > 5 ? ` … (+${ld.changedLessons.length - 5})` : ''}`);
          }
          if (ld.removedLessons.length) {
            console.log(`        - bài xóa: ${ld.removedLessons.slice(0, 5).map((l) => l.name).join(', ')}${ld.removedLessons.length > 5 ? ` … (+${ld.removedLessons.length - 5})` : ''}`);
          }
        }
      });
    }
    if (skipTabs.length) {
      console.log(`\n  ✓ Không đổi (${skipTabs.length}):`);
      skipTabs.forEach((p) => console.log(`    = "${p.tabName}" (${p.diff.reason})`));
    }
    for (const p of changedTabs) {
      const snapshot = await snapshotUserEditsDetailed(sheets, spreadsheetId, p.diff.prevTabName || p.tabName, p.course);
      if (snapshot.diagnostics.warnings.length || snapshot.diagnostics.blockingRisks.length) {
        runSummary.preserveRisks.push({ tabName: p.tabName, diagnostics: snapshot.diagnostics });
        console.log(`\n  Preserve risk: "${p.tabName}"`);
        snapshot.diagnostics.warnings.forEach((w) => console.log(`    warn: ${w}`));
        snapshot.diagnostics.blockingRisks.forEach((r) => console.log(`    BLOCK: ${r}`));
      }
    }
    const orphans = findOrphanTabs(syncState, courses.map((c) => c.id));
    if (orphans.length) {
      console.log(`\n  🗑 Tab orphan (khóa đã xóa khỏi Drive) (${orphans.length}):`);
      orphans.forEach((o) => console.log(`    - "${o.tabName}" (courseId: ${o.courseId})`));
    }
    console.log(`\nChạy với --sync để áp dụng thay đổi.`);
    runSummary.tabs = plan.map((p) => ({ tabName: p.tabName, courseId: p.course.id, action: p.diff.action, reason: p.diff.reason }));
    runSummary.orphans = orphans;
    emitJsonSummary(args, runSummary);
    return;
  }

  if (args.verifyOnly) {
    console.log('\nVERIFY ONLY: readback rendered tabs without writing.');
    for (const p of plan) {
      const sheetId = await findSheetIdByTitle(sheets, spreadsheetId, p.tabName);
      if (sheetId == null) {
        runSummary.failed++;
        runSummary.tabs.push({ tabName: p.tabName, courseId: p.course.id, status: 'missing' });
        console.log(`  FAIL "${p.tabName}": missing tab`);
        continue;
      }
      const built = buildCourseTab(p.course, p.courseSchema, { maxVideos: args.maxVideos, allFiles: !!args.allFiles });
      const verification = await verifyRenderedTab(sheets, spreadsheetId, sheetId, built);
      if (verification.ok) {
        runSummary.verified++;
        runSummary.tabs.push({ tabName: p.tabName, courseId: p.course.id, status: 'ok', warnings: verification.warnings });
        console.log(`  ok "${p.tabName}"${verification.warnings.length ? ` (${verification.warnings.length} warning)` : ''}`);
      } else {
        runSummary.failed++;
        runSummary.tabs.push({ tabName: p.tabName, courseId: p.course.id, status: 'failed', errors: verification.errors });
        console.log(`  FAIL "${p.tabName}": ${verification.errors.join('; ')}`);
      }
    }
    emitJsonSummary(args, runSummary);
    if (runSummary.failed) process.exit(1);
    return;
  }

  const summaries = [];
  let rendered = 0;
  let syncSkipped = 0;
  // Tổng hợp run report cuối phiên
  const reportNew = [];
  const reportChanged = [];
  const reportNewLessons = [];        // [{tabName, lessonName}]
  const reportChangedLessons = [];
  const reportRemovedLessons = [];

  for (let i = 0; i < plan.length; i++) {
    const { course: c, courseSchema, tabName, courseCfg, diff } = plan[i];
    console.log(`\n  [${i + 1}/${plan.length}] ${c.name}`);
    console.log(`    Tab: '${tabName}'${courseCfg ? ' [v2]' : ''}`);

    // --sync mode: bỏ qua tab không đổi
    if (syncMode && diff.action === 'skip') {
      console.log(`    ⏭ skip — ${diff.reason}`);
      syncSkipped++;
      runSummary.skipped = syncSkipped;
      // Backfill lessons silently nếu state cũ chưa có (migration sau update)
      if (diff.needsBackfill && !args.dryRun) {
        markRendered(syncState, c, tabName, checkpointMeta);
        saveState(args.teacherFolder, syncState);
      }
      // Vẫn đưa vào summaries để INDEX đầy đủ
      const built = buildCourseTab(c, courseSchema, { maxVideos: args.maxVideos, allFiles: !!args.allFiles });
      summaries.push({ courseId: c.id, courseName: c.name, tabName, leafCount: built.leafCount, totalVideos: built.totalVideos });
      continue;
    }

    if (syncMode && diff.action === 'changed') {
      console.log(`    🔄 thay đổi — ${diff.reason}`);
      reportChanged.push({ tabName, courseName: c.name, reason: diff.reason });
      if (diff.lessonDiff) {
        diff.lessonDiff.newLessons.forEach((l) => reportNewLessons.push({ tabName, lessonName: l.name }));
        diff.lessonDiff.changedLessons.forEach((l) => reportChangedLessons.push({ tabName, lessonName: l.name }));
        diff.lessonDiff.removedLessons.forEach((l) => reportRemovedLessons.push({ tabName, lessonName: l.name }));
      }
      // Nếu tab đổi tên → rename tab cũ (giữ sheetId, giữ user-edit) để không phá link share
      if (diff.prevTabName && diff.prevTabName !== tabName && !args.dryRun) {
        try {
          const oldSheetId = await findSheetIdByTitle(sheets, spreadsheetId, diff.prevTabName);
          if (oldSheetId != null) {
            await renameTab(sheets, spreadsheetId, oldSheetId, tabName);
            console.log(`    ✎ Đã rename tab cũ "${diff.prevTabName}" → "${tabName}"`);
          }
        } catch (e) {
          console.log(`    ⚠ Không rename được tab cũ "${diff.prevTabName}": ${e.message}`);
        }
      }
    }

    if (syncMode && diff.action === 'new') {
      console.log(`    🆕 tab mới`);
      reportNew.push({ tabName, courseName: c.name });
      // Tab mới → mọi lesson đều là "lesson mới"
      (diff.currentLessons || []).forEach((l) => reportNewLessons.push({ tabName, lessonName: l.name }));
    }

    // Snapshot user-edit (Trạng thái + Ghi chú) từ tab cũ trước khi rewrite
    let userEditByLessonId = new Map();
    if (!args.dryRun && args.preserveUserEdits) {
      try {
        const snapshot = await snapshotUserEditsDetailed(sheets, spreadsheetId, tabName, c);
        userEditByLessonId = snapshot.edits;
        if (snapshot.diagnostics.warnings.length || snapshot.diagnostics.blockingRisks.length) {
          runSummary.preserveRisks.push({ tabName, diagnostics: snapshot.diagnostics });
          snapshot.diagnostics.warnings.forEach((w) => console.log(`    warn: ${w}`));
          snapshot.diagnostics.blockingRisks.forEach((r) => console.log(`    BLOCK: ${r}`));
          if (snapshot.diagnostics.blockingRisks.length && !args.allowPreserveRisk) {
            throw new Error(`Preserve risk blocked for "${tabName}". Re-run with --allow-preserve-risk only after manual review.`);
          }
        }
        if (userEditByLessonId.size) {
          console.log(`    💾 Preserve ${userEditByLessonId.size} user-edit (Trạng thái/Ghi chú)`);
        }
      } catch (e) {
        if (/Preserve risk blocked/.test(e.message || '')) throw e;
        console.log(`    ⚠ Không snapshot được user-edit: ${e.message}`);
      }
    }

    const built = buildCourseTab(c, courseSchema, { maxVideos: args.maxVideos, allFiles: !!args.allFiles, userEditByLessonId });
    console.log(`    ${built.leafCount} bài, ${built.totalVideos} video`);

    if (args.dryRun) {
      console.log('    [DRY-RUN] không ghi');
    } else {
      const sheetId = await ensureTab(sheets, spreadsheetId, tabName);
      await writeRichValues(sheets, spreadsheetId, sheetId, built.rows);
      await applyTabFormatting(sheets, spreadsheetId, sheetId, built);
      await hideColumn(sheets, spreadsheetId, sheetId, built.NCOL - 1);
      const verification = await verifyRenderedTab(sheets, spreadsheetId, sheetId, built);
      if (!verification.ok) {
        throw new Error(`Post-write verification failed for "${tabName}": ${verification.errors.join('; ')}`);
      }
      verification.warnings.forEach((w) => console.log(`    verify warning: ${w}`));
      // Lưu state sau khi render thành công
      markRendered(syncState, c, tabName, { ...checkpointMeta, tabId: sheetId, stats: { leafCount: built.leafCount, totalVideos: built.totalVideos } });
      saveState(args.teacherFolder, syncState);
      runSummary.verified++;
      console.log('    ✓ Đã ghi tab');
    }

    rendered++;
    runSummary.rendered = rendered;
    summaries.push({
      courseId: c.id,
      courseName: c.name,
      tabName,
      leafCount: built.leafCount,
      totalVideos: built.totalVideos,
    });
  }

  // Xử lý tab orphan trong --sync mode (khóa đã xóa khỏi Drive).
  // Archive bằng rename (giữ sheetId, không phá link share + dữ liệu user).
  // KHÔNG xóa khỏi state để lần sau vẫn cảnh báo nếu user chưa kịp xử lý.
  const reportOrphans = [];
  if (syncMode && !args.dryRun) {
    const orphans = findOrphanTabs(syncState, courses.map((c) => c.id));
    if (orphans.length) {
      console.log(`\n  Phát hiện ${orphans.length} tab orphan (khóa đã xóa khỏi Drive):`);
      for (const o of orphans) {
        const archivedName = o.tabName.startsWith('🗑 ') ? o.tabName : `🗑 ${o.tabName}`;
        try {
          const sid = await findSheetIdByTitle(sheets, spreadsheetId, o.tabName);
          if (sid != null && o.tabName !== archivedName) {
            await renameTab(sheets, spreadsheetId, sid, shortenTabName(archivedName, 99));
            console.log(`    🗑 Archive: "${o.tabName}" → "${archivedName}"`);
            reportOrphans.push({ tabName: archivedName, courseId: o.courseId });
            markArchived(syncState, o.courseId, shortenTabName(archivedName, 99), { tabId: sid, spreadsheetId });
          } else if (sid == null) {
            console.log(`    ⚠ "${o.tabName}" không còn trong sheet → bỏ khỏi state`);
            markRemoved(syncState, o.courseId);
          }
        } catch (e) {
          console.log(`    ⚠ Không archive được "${o.tabName}": ${e.message}`);
        }
      }
      saveState(args.teacherFolder, syncState);
    }
  }

  const indexTab = '📚 INDEX BÀI HỌC';
  console.log(`\nCập nhật tab tổng hợp: '${indexTab}'`);
  if (!args.dryRun) {
    const idxId = await ensureTab(sheets, spreadsheetId, indexTab);
    const idxRows = buildIndexRows(summaries, teacherName, args.teacherFolder, schema);
    await writeRichValues(sheets, spreadsheetId, idxId, idxRows);
    await applyIndexFormatting(sheets, spreadsheetId, idxId, idxRows.length);
  }

  console.log('\n✓ Hoàn tất.');
  if (syncMode) {
    console.log(`  Render: ${rendered} tab | Skip: ${syncSkipped} tab (không đổi)`);

    // Run report — tóm tắt thay đổi phiên này (chỉ xuất khi syncMode)
    const totalLessonChanges = reportNewLessons.length + reportChangedLessons.length + reportRemovedLessons.length;
    if (reportNew.length || reportChanged.length || reportOrphans.length || totalLessonChanges) {
      console.log('\n📊 RUN REPORT:');
      if (reportNew.length) {
        console.log(`  🆕 ${reportNew.length} tab mới:`);
        reportNew.forEach((r) => console.log(`     + "${r.tabName}" (${r.courseName})`));
      }
      if (reportChanged.length) {
        console.log(`  🔄 ${reportChanged.length} tab đổi:`);
        reportChanged.forEach((r) => console.log(`     ~ "${r.tabName}" — ${r.reason}`));
      }
      if (reportOrphans.length) {
        console.log(`  🗑 ${reportOrphans.length} tab archived:`);
        reportOrphans.forEach((r) => console.log(`     - "${r.tabName}"`));
      }
      if (reportNewLessons.length) {
        console.log(`  📚 ${reportNewLessons.length} bài mới được thêm:`);
        const byTab = {};
        reportNewLessons.forEach((l) => { (byTab[l.tabName] = byTab[l.tabName] || []).push(l.lessonName); });
        Object.entries(byTab).forEach(([t, names]) => {
          console.log(`     [${t}] ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` … (+${names.length - 5})` : ''}`);
        });
      }
      if (reportChangedLessons.length) {
        console.log(`  ✏ ${reportChangedLessons.length} bài cập nhật nội dung`);
      }
      if (reportRemovedLessons.length) {
        console.log(`  ⊖ ${reportRemovedLessons.length} bài bị xóa khỏi Drive`);
      }
    } else {
      console.log('  (Không có thay đổi nào trong phiên này)');
    }
  }
  console.log(`  Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  runSummary.tabs = summaries.map((s) => ({ tabName: s.tabName, courseId: s.courseId, leafCount: s.leafCount, totalVideos: s.totalVideos }));
  runSummary.orphans = reportOrphans;
  emitJsonSummary(args, runSummary);
  console.log(`  Tổng: ${summaries.reduce((s, c) => s + c.totalVideos, 0)} video / ${summaries.reduce((s, c) => s + c.leafCount, 0)} bài`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('LỖI:', e.message);
    if (e.response && e.response.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildCourseTab,
  applyTabFormatting,
  loadSchemaV2,
  resolveCourseSchemaV2,
  snapshotUserEditsDetailed,
  cleanLessonName,
  shortCourseLabel,
  dedupeTabNames,
  LESSON_ID_HEADER,
  RENDERER_VERSION,
  STYLE_VERSION,
};
