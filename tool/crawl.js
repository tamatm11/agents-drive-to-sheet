// Stage 1: Crawl Drive folder của 1 giáo viên → tree.json thuần (không decoration).
// Cache tại trees/<teacherFolderId>.json (timestamp + tree). Re-crawl khi --force.
//
// CLI:
//   node crawl.js --teacher <folderId>          # dùng cache nếu có
//   node crawl.js --teacher <folderId> --force  # ép crawl lại
//   node crawl.js --teacher <folderId> --max-age 24h  # invalidate sau N giờ
//
// Module API:
//   const { crawlTeacher, loadCachedTree } = require('./crawl');
//   const tree = await crawlTeacher(drive, teacherFolderId, { force, maxAgeMs });

const fs = require('fs');
const path = require('path');
const { getClients } = require('./auth');
const { listChildren, walk, FOLDER_MIME } = require('./drive');
const { withRetry } = require('./utils');

const TREES_DIR = path.join(__dirname, 'trees');

function ensureTreesDir() {
  if (!fs.existsSync(TREES_DIR)) fs.mkdirSync(TREES_DIR, { recursive: true });
}

function treePath(teacherFolderId) {
  return path.join(TREES_DIR, `${teacherFolderId}.json`);
}

function loadCachedTree(teacherFolderId, { maxAgeMs } = {}) {
  const p = treePath(teacherFolderId);
  if (!fs.existsSync(p)) return null;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
  if (maxAgeMs && payload.crawledAt) {
    const age = Date.now() - new Date(payload.crawledAt).getTime();
    if (age > maxAgeMs) return null;
  }
  return payload;
}

function saveTree(teacherFolderId, payload) {
  ensureTreesDir();
  fs.writeFileSync(treePath(teacherFolderId), JSON.stringify(payload, null, 2));
}

// Quét cấp 1 (folder cấp 3 = các khóa học bên trong folder giáo viên), gom thành 1 tree
// có root đại diện folder giáo viên, mỗi child cấp 1 = 1 khóa học, sau đó walk DFS.
async function crawlTeacher(drive, teacherFolderId, { force = false, maxAgeMs, onProgress } = {}) {
  if (!force) {
    const cached = loadCachedTree(teacherFolderId, { maxAgeMs });
    if (cached) return { ...cached, fromCache: true };
  }

  // Metadata giáo viên
  const meta = await withRetry(
    () => drive.files.get({ fileId: teacherFolderId, fields: 'id, name, modifiedTime, webViewLink' }),
    { context: `get teacher ${teacherFolderId}` },
  );
  const teacher = {
    id: meta.data.id,
    name: meta.data.name,
    modifiedTime: meta.data.modifiedTime,
    webViewLink: meta.data.webViewLink,
  };

  // Cấp 1 của giáo viên = các khóa học (folder cấp 3 trong cây tổng)
  const kids = await listChildren(drive, teacherFolderId);
  const courses = kids.filter((k) => k.mimeType === FOLDER_MIME);

  const courseTrees = [];
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    if (onProgress) onProgress({ phase: 'course-start', index: i, total: courses.length, name: c.name });
    const root = await walk(drive, c.id, {
      onProgress: (p) => onProgress && onProgress({ phase: 'walk', course: c.name, ...p }),
    });
    root.name = c.name;
    root.id = c.id;
    root.webViewLink = c.webViewLink;
    root.modifiedTime = c.modifiedTime;
    courseTrees.push(root);
    if (onProgress) onProgress({ phase: 'course-done', index: i, total: courses.length, name: c.name });
  }

  const payload = {
    crawledAt: new Date().toISOString(),
    teacher,
    courses: courseTrees,
  };

  saveTree(teacherFolderId, payload);
  return { ...payload, fromCache: false };
}

// Crawl incremental: chỉ walk lại các course có id trong onlyCourseIds.
// Course không thuộc set này thì giữ nguyên cây cũ từ cachedTree.
// Nếu cachedTree rỗng → tự fall back sang full crawl.
//
// Đây là path "rẻ" cho daily sync: thường chỉ 1-2 khóa đổi trong 30+ khóa.
async function crawlTeacherIncremental(drive, teacherFolderId, onlyCourseIds, { onProgress } = {}) {
  const cached = loadCachedTree(teacherFolderId);
  if (!cached || !Array.isArray(cached.courses) || cached.courses.length === 0) {
    return crawlTeacher(drive, teacherFolderId, { force: true, onProgress });
  }

  // Refresh metadata teacher
  const meta = await withRetry(
    () => drive.files.get({ fileId: teacherFolderId, fields: 'id, name, modifiedTime, webViewLink' }),
    { context: `get teacher ${teacherFolderId}` },
  );
  const teacher = {
    id: meta.data.id,
    name: meta.data.name,
    modifiedTime: meta.data.modifiedTime,
    webViewLink: meta.data.webViewLink,
  };

  // Lấy danh sách course hiện tại trên Drive (cấp 1) để biết course mới + đã xóa
  const kids = await listChildren(drive, teacherFolderId);
  const liveCourses = kids.filter((k) => k.mimeType === FOLDER_MIME);
  const liveById = new Map(liveCourses.map((c) => [c.id, c]));

  const wantWalk = new Set(onlyCourseIds || []);
  // Course mới (chưa có trong cache) cũng phải walk
  const cachedIds = new Set(cached.courses.map((c) => c.id));
  for (const c of liveCourses) if (!cachedIds.has(c.id)) wantWalk.add(c.id);

  const result = [];
  let walked = 0;
  for (let i = 0; i < liveCourses.length; i++) {
    const c = liveCourses[i];
    if (wantWalk.has(c.id)) {
      if (onProgress) onProgress({ phase: 'course-start', index: walked, total: wantWalk.size, name: c.name });
      const root = await walk(drive, c.id, {
        onProgress: (p) => onProgress && onProgress({ phase: 'walk', course: c.name, ...p }),
      });
      root.name = c.name;
      root.id = c.id;
      root.webViewLink = c.webViewLink;
      root.modifiedTime = c.modifiedTime;
      result.push(root);
      walked++;
      if (onProgress) onProgress({ phase: 'course-done', index: walked, total: wantWalk.size, name: c.name });
    } else {
      // Giữ nguyên cây cũ, chỉ refresh modifiedTime nếu Drive trả mới hơn
      const old = cached.courses.find((cc) => cc.id === c.id);
      if (old) {
        if (c.modifiedTime && c.modifiedTime > (old.modifiedTime || '')) old.modifiedTime = c.modifiedTime;
        result.push(old);
      }
    }
  }

  const payload = {
    crawledAt: new Date().toISOString(),
    teacher,
    courses: result,
    incremental: { walkedCourseIds: Array.from(wantWalk), keptCourseIds: result.filter((r) => !wantWalk.has(r.id)).map((r) => r.id) },
  };
  saveTree(teacherFolderId, payload);
  return { ...payload, fromCache: false };
}

function parseArgs(argv) {
  const out = { force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teacher' || a === '-t') out.teacherFolder = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--max-age') out.maxAge = argv[++i];
  }
  return out;
}

function parseDuration(s) {
  if (!s) return undefined;
  const m = /^(\d+)\s*(h|d|m)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] || 'h').toLowerCase();
  if (unit === 'h') return n * 3600 * 1000;
  if (unit === 'd') return n * 86400 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return undefined;
}

function countNodes(tree) {
  let folders = 0;
  let files = 0;
  function visit(node) {
    folders++;
    files += node.files.length;
    for (const c of node.children) visit(c);
  }
  for (const c of tree.courses) visit(c);
  return { folders, files };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.teacherFolder) {
    console.error('Thiếu --teacher <folderId>');
    process.exit(1);
  }
  const { drive } = getClients();
  const maxAgeMs = parseDuration(args.maxAge);

  console.log(`Crawl giáo viên ${args.teacherFolder}${args.force ? ' [force]' : ''}`);
  const t0 = Date.now();
  const tree = await crawlTeacher(drive, args.teacherFolder, {
    force: args.force,
    maxAgeMs,
    onProgress: (p) => {
      if (p.phase === 'course-start') {
        process.stdout.write(`  [${p.index + 1}/${p.total}] ${p.name}\n`);
      } else if (p.phase === 'walk' && p.folderCount && p.folderCount % 25 === 0) {
        process.stdout.write(`     ...crawled ${p.folderCount} folders\r`);
      }
    },
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = countNodes(tree);
  console.log(`\n${tree.fromCache ? 'Dùng cache' : 'Đã crawl'} — ${tree.courses.length} khóa, ${stats.folders} folder, ${stats.files} file (${dt}s)`);
  console.log(`Cache: ${treePath(args.teacherFolder)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('LỖI:', e.message);
    if (e.response && e.response.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  });
}

module.exports = { crawlTeacher, crawlTeacherIncremental, loadCachedTree, treePath, TREES_DIR };
