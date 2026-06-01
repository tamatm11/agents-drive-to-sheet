// Subagent helper: sinh schema-v2 per-course từ tree JSON.
//
// CLI:
//   node build-schema-v2.js --teacher <folderId>
//   node build-schema-v2.js --teacher <id> --tree <path>
//   node build-schema-v2.js --teacher <id> --dry-run
//   node build-schema-v2.js --teacher <id> --force
//   node build-schema-v2.js --teacher <id> --out <path>
//
// Đọc:
//   ưu tiên --tree <path>
//   fallback skill output: ~/.claude/skills/drive-tree-crawl/output/<id>-*.json (mới nhất)
//   fallback tool cache:   ~/.claude/agents/tool/trees/<id>.json
// Ghi:
//   ~/.claude/agents/tool/schemas-v2/<id>.json (idempotent, --force để overwrite)
//
// Rule-based 100% — nếu confidence < 0.7, ghi vào notes để user review.
// (AI hook để TODO; helper hiện chưa gọi AI.)

const fs = require('fs');
const path = require('path');

const TOOL_DIR    = path.join(process.env.USERPROFILE || process.env.HOME, '.claude/agents/tool');
const SKILL_OUT   = path.join(process.env.USERPROFILE || process.env.HOME, '.claude/skills/drive-tree-crawl/output');
const SCHEMAS_V2  = path.join(TOOL_DIR, 'schemas-v2');
const TREES_DIR   = path.join(TOOL_DIR, 'trees');

function parseArgs(argv) {
  const out = { dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teacher' || a === '-t') out.teacher = argv[++i];
    else if (a === '--tree') out.tree = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
  }
  return out;
}

function findLatestSkillTree(teacherId) {
  if (!fs.existsSync(SKILL_OUT)) return null;
  const matches = fs.readdirSync(SKILL_OUT)
    .filter((f) => f.startsWith(teacherId + '-') && f.endsWith('.json'))
    .map((f) => ({ f, full: path.join(SKILL_OUT, f), mtime: fs.statSync(path.join(SKILL_OUT, f)).mtimeMs }));
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].full;
}

function loadTreeAny(opts) {
  if (opts.tree && fs.existsSync(opts.tree)) {
    return { path: opts.tree, raw: JSON.parse(fs.readFileSync(opts.tree, 'utf8')), source: 'arg' };
  }
  const skill = findLatestSkillTree(opts.teacher);
  if (skill) return { path: skill, raw: JSON.parse(fs.readFileSync(skill, 'utf8')), source: 'skill' };
  const tool = path.join(TREES_DIR, opts.teacher + '.json');
  if (fs.existsSync(tool)) return { path: tool, raw: JSON.parse(fs.readFileSync(tool, 'utf8')), source: 'tool' };
  return null;
}

// Adapter: skill format `{ root, ... }` → `{ teacher: {id,name}, courses: [...] }`.
function normalizeTree(raw, teacherId) {
  if (raw.root) {
    return {
      teacher: { id: raw.root.id, name: raw.root.name },
      courses: (raw.root.children || []).slice(),
      crawledAt: raw.crawledAt,
    };
  }
  if (raw.teacher && Array.isArray(raw.courses)) {
    return { teacher: raw.teacher, courses: raw.courses.slice(), crawledAt: raw.crawledAt };
  }
  throw new Error(`Tree format không nhận diện được (file: ${teacherId})`);
}

// Match render.js skip rules (locked source of truth).
const META_PATTERNS = [
  /\binfo\b/, /\bthong tin\b/, /\bebook\b/, /\bsach kem\b/,
  /\bhuong dan\b/, /\bgioi thieu\b/, /\blo trinh\b/, /\btai lieu kem\b/,
];
function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function isMetaCourse(name) {
  if (/^z\b/i.test(String(name || '').trim())) return true;
  const n = normalizeName(name);
  return META_PATTERNS.some((re) => re.test(n));
}

// Đếm depth + file histogram cho 1 course (đệ quy).
function analyzeCourse(course) {
  let maxFolderDepth = 0;
  const fileByDepth = {};
  function walk(node, d) {
    const files = node.files || [];
    if (files.length) fileByDepth[d] = (fileByDepth[d] || 0) + files.length;
    const subs = (node.children || []);
    if (subs.length) {
      maxFolderDepth = Math.max(maxFolderDepth, d + 1);
      subs.forEach((c) => walk(c, d + 1));
    }
  }
  // Course = depth 0; children = depth 1.
  if ((course.children || []).length) maxFolderDepth = Math.max(maxFolderDepth, 1);
  (course.children || []).forEach((c) => walk(c, 1));
  if ((course.files || []).length) fileByDepth[0] = (fileByDepth[0] || 0) + course.files.length;
  return { maxFolderDepth, fileByDepth };
}

// Detect pattern + confidence từ tên child cấp 1.
const NAME_PATTERNS = [
  { name: 'chuong',   re: /^\d+\.?\s*(chương|chuong|chapter)\b/i },
  { name: 'bai',      re: /^\d+\.?\s*\[?\s*(bài|bai|lesson)\b/i },
  { name: 'buoi',     re: /^\d+\.?\s*(buổi|buoi)\b/i },
  { name: 'tiet',     re: /^\d+\.?\s*\[?\s*(tiết|tiet)\b/i },
  { name: 'theme',    re: /^\d+\.?\s*theme\b/i },
  { name: 'code',     re: /^[A-Z]{2,6}\d{1,3}/ },
  { name: 'numeric',  re: /^\d+\.\s+\S+/ },
];
function detectNamePattern(names) {
  if (!names.length) return { pattern: null, ratio: 0 };
  const counts = {};
  for (const n of names) {
    for (const p of NAME_PATTERNS) {
      if (p.re.test(n.trim())) { counts[p.name] = (counts[p.name] || 0) + 1; break; }
    }
  }
  let best = null, max = 0;
  for (const [k, v] of Object.entries(counts)) if (v > max) { best = k; max = v; }
  return { pattern: best, ratio: max / names.length };
}

function classifyCourse(course) {
  const { maxFolderDepth, fileByDepth } = analyzeCourse(course);
  const totalFiles = Object.values(fileByDepth).reduce((a, b) => a + b, 0);
  const subs = (course.children || []);
  const childNames = subs.map((c) => c.name);
  const detected = detectNamePattern(childNames);

  if (maxFolderDepth === 0 && totalFiles === 0) {
    return { pattern: 'empty', depth: 0, totalFiles, namePattern: null, ratio: 0, confidence: 0 };
  }
  let pattern;
  if (maxFolderDepth <= 1) pattern = 'flat';
  else if (maxFolderDepth === 2) pattern = 'chap_then_lesson';
  else pattern = 'chap_then_lesson_then_session';

  // confidence: pattern rõ + tên có prefix số / mã code → high
  let conf = 0.4;
  if (detected.ratio >= 0.7) conf = 0.9;
  else if (detected.ratio >= 0.4) conf = 0.7;
  else if (totalFiles > 0) conf = 0.55;

  return {
    pattern, depth: maxFolderDepth, totalFiles,
    namePattern: detected.pattern, ratio: detected.ratio, confidence: conf,
    fileByDepth,
  };
}

const LEVEL_DEFAULTS = [
  { label: 'Chương / Chuyên đề', icon: '📖', bold: true,  bg: '#FCE5C0' },
  { label: 'Bài',                icon: '📂', bold: true,  bg: '#FCF1D4' },
  { label: 'Tiết / Phần',        icon: '📁', bold: false, bg: '#F2FAEA' },
];
const DEFAULT_LEAF = { label: 'Bài', icon: '📂', bold: true, bg: '#FCF1D4' };
const DEFAULT_COURSE_ROW = { icon: '📚', bold: true, fontSize: 12, bg: '#D4E5FA' };

function buildLevels(depth) {
  const n = Math.max(1, Math.min(3, depth || 1));
  return Array.from({ length: n }, (_, d) => ({
    depth: d,
    label: LEVEL_DEFAULTS[Math.min(d, LEVEL_DEFAULTS.length - 1)].label,
    icon: LEVEL_DEFAULTS[Math.min(d, LEVEL_DEFAULTS.length - 1)].icon,
    bold: LEVEL_DEFAULTS[Math.min(d, LEVEL_DEFAULTS.length - 1)].bold,
    bg: LEVEL_DEFAULTS[Math.min(d, LEVEL_DEFAULTS.length - 1)].bg,
  }));
}

// Sinh tabName ngắn từ tên course.
//   "1. VOD - Địa lí 12 - Khóa 2K9 Xuất phát sớm 2027 - Thầy Trần Văn Tài"
// → "VOD Địa 1"
//   "4. TOÁN THẦY ĐỖ VĂN ĐỨC TENS 2K9" → "Khóa T"
function shortTabName(name) {
  let raw = String(name || '').trim();
  // Số thứ tự đầu (giữ lại để dedup downstream)
  const numMatch = /^(\d+)\.\s*/.exec(raw);
  const courseNum = numMatch ? numMatch[1] : '';
  let n = raw.replace(/^\d+\.\s*/, '');
  // Pattern KHÓA <CODE> → "Khóa <CODE>"
  const m = /KHO[ÁA]\s+([A-Z]{2,6}\d?)/i.exec(n);
  if (m) return `Khóa ${m[1].toUpperCase()}`;
  // Loại đuôi "Thầy …", "Cô …", năm 4 chữ số, "2K9"
  n = n.replace(/[-–|]\s*Thầy[^-–|]*$/i, '').replace(/[-–|]\s*Cô[^-–|]*$/i, '').trim();
  n = n.replace(/\s*(20\d{2})\s*/g, ' ').replace(/\s+2[Kk]\d\s*/g, ' ').trim();
  // Loại "Khóa 2K9 …" giữa
  n = n.replace(/\bKhóa\b/gi, '').trim();
  // VOD / Live / XPS prefix
  const kindMatch = /^(VOD|LIVE|XPS|LUYEN|LIVESTREAM)\b/i.exec(n);
  const kind = kindMatch ? kindMatch[1].toUpperCase() : '';
  // Lấy môn / topic chính (3 từ đầu sau prefix)
  let body = kindMatch ? n.slice(kindMatch[0].length).trim() : n;
  body = body.replace(/^[-–|:\s]+/, '').replace(/[-–|]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = body.split(/\s+/).filter(Boolean).slice(0, 2);
  let out = [kind, ...words].filter(Boolean).join(' ');
  if (courseNum) out = `${out} ${courseNum}`.trim();
  if (out.length > 28) out = out.slice(0, 27) + '…';
  return out || `Khóa ${courseNum || '?'}`.trim();
}

// Đảm bảo unique tab name (Sheets không cho trùng).
function dedupTabNames(entries) {
  const seen = new Map();
  for (const e of entries) {
    const base = e.tabName;
    let n = base;
    let i = 2;
    while (seen.has(n)) { n = `${base} #${i++}`; }
    seen.set(n, true);
    e.tabName = n;
  }
}

function buildSchemaV2(teacher, courses) {
  const renderable = courses.filter((c) => !isMetaCourse(c.name));
  const metaSkip = courses.filter((c) => isMetaCourse(c.name)).map((c) => c.name);

  const courseEntries = renderable.map((c) => {
    const cls = classifyCourse(c);
    const entry = {
      courseId: c.id,
      courseName: c.name,
      tabName: shortTabName(c.name),
      structure: cls.pattern === 'flat' ? 'by-lesson'
        : cls.pattern === 'chap_then_lesson' ? 'by-chapter'
        : cls.pattern === 'chap_then_lesson_then_session' ? 'by-chapter-session'
        : 'empty',
      depth: cls.depth,
      pattern: cls.pattern,
      confidence: Math.round(cls.confidence * 100) / 100,
      decidedBy: cls.confidence >= 0.7 ? 'rule' : 'rule-fallback',
      filesTotal: cls.totalFiles,
      notes: cls.pattern === 'empty'
        ? 'Khóa rỗng (chưa upload nội dung). Render sẽ tạo tab placeholder.'
        : `Pattern '${cls.pattern}' depth=${cls.depth}, name pattern '${cls.namePattern || 'mixed'}' (${Math.round(cls.ratio * 100)}%).`,
    };
    // Nếu depth khác defaults (=1), gắn levels riêng
    if (cls.depth >= 1 && cls.depth !== 1) {
      entry.levels = buildLevels(cls.depth);
    }
    return entry;
  });

  dedupTabNames(courseEntries);

  return {
    teacherId: teacher.id,
    teacherName: teacher.name,
    generatedAt: new Date().toISOString(),
    generatedBy: 'ai-sheet-structurer-v1',
    defaults: {
      levels: buildLevels(1),
      leafFallback: { ...DEFAULT_LEAF, note: 'Một số khóa file nằm cấp nông hơn — render thẳng như leaf bài học.' },
      courseRow: { ...DEFAULT_COURSE_ROW },
      videoRow: { icon: '▸', indent: 'extra-from-leaf' },
    },
    courses: courseEntries,
    _meta: {
      version: 1,
      source: 'rule-based',
      total_courses: courses.length,
      renderable: renderable.length,
      meta_skipped: metaSkip,
      confidence_summary: {
        high:   courseEntries.filter((c) => c.confidence >= 0.7).length,
        medium: courseEntries.filter((c) => c.confidence >= 0.4 && c.confidence < 0.7).length,
        low:    courseEntries.filter((c) => c.confidence < 0.4).length,
      },
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.teacher) {
    console.error('Thiếu --teacher <folderId>');
    process.exit(1);
  }
  if (!fs.existsSync(SCHEMAS_V2)) fs.mkdirSync(SCHEMAS_V2, { recursive: true });

  const loaded = loadTreeAny(args);
  if (!loaded) {
    console.error(`Không tìm thấy tree cho ${args.teacher}.`);
    console.error(`  Thử chạy: drive-tree-crawl skill hoặc node ${TOOL_DIR}/crawl.js --teacher ${args.teacher}`);
    process.exit(1);
  }
  const tree = normalizeTree(loaded.raw, args.teacher);
  // Sanity: teacher.id phải match (skill format root.id, tool format teacher.id)
  if (tree.teacher.id !== args.teacher) {
    console.error(`⚠ tree.teacher.id (${tree.teacher.id}) ≠ --teacher (${args.teacher})`);
  }

  const payload = buildSchemaV2(tree.teacher, tree.courses);
  const outPath = args.out || path.join(SCHEMAS_V2, `${args.teacher}.json`);

  if (args.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\n[DRY-RUN] không ghi. Path target: ${outPath}`);
    return;
  }

  if (fs.existsSync(outPath) && !args.force) {
    console.error(`Schema-v2 đã tồn tại: ${outPath}`);
    console.error('  Dùng --force để ghi đè.');
    process.exit(2);
  }

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`✓ Schema-v2 ghi: ${outPath}`);
  console.log(`  Teacher: ${tree.teacher.name} (${tree.teacher.id})`);
  console.log(`  Tree:    ${loaded.path} [${loaded.source}]`);
  console.log(`  Courses: ${payload._meta.total_courses} total / ${payload._meta.renderable} render-able / ${payload._meta.meta_skipped.length} meta-skip`);
  const cs = payload._meta.confidence_summary;
  console.log(`  Conf:    ${cs.high}H ${cs.medium}M ${cs.low}L`);
  console.log(`\n  Render: node ${TOOL_DIR}/render.js --teacher ${args.teacher}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('LỖI:', e.message); process.exit(1); }
}

module.exports = { buildSchemaV2, classifyCourse, normalizeTree, isMetaCourse };
