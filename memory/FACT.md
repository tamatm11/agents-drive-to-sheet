# Agent Facts

## Project: adaptive-drive-to-sheet

### Architecture
- Agent spec: `C:\Users\giaos\.claude\agents\adaptive-drive-to-sheet.md`
- Tool backend: `C:\Users\giaos\.claude\agents\tool\`
- Crawl output: `C:\Users\giaos\.claude\mcp-servers\gdrive-mcp\crawl-output\`
- Trees cache: `C:\Users\giaos\.claude\agents\tool\trees\`
- Schemas: `C:\Users\giaos\.claude\agents\tool\schemas\`
- Schemas-v2 (per-course): `C:\Users\giaos\.claude\agents\tool\schemas-v2\`
- Sync states: `C:\Users\giaos\.claude\agents\tool\sync-states\` (course + lesson level)

### Pipeline (3 stages + sync layer)
- Stage 1: `crawl.js` → `trees/<teacherId>.json` (full crawl) or `crawlTeacherIncremental(onlyCourseIds)` (selective)
- Stage 2: `infer-schema.js` → `schemas/<teacherId>.json` (AI-inferred or hand-written)
- Stage 3: `render.js` → writes Google Sheet (one tab per course + INDEX tab)
- Sync layer: `sync-state.js` tracks course + lesson checksums for incremental updates

### render.js — Dynamic Columns + User-Edit Preservation (rewritten 2026-05-29)

**Dynamic resource columns per course:**
- `scanCourseFileKinds(course)` walks the course tree once (O(n)), classifies each file via `classifyFile()`, returns Set of kind strings.
- `buildDynamicColumns(presentKinds)` filters `ALL_RESOURCE_COLUMNS` to only include columns whose kinds are present.
- Column definitions: BG (Bài giảng), DE (Đề tự luyện), KEY (Check Key), CHUA (Chữa đề), BVT (BVT / Khác for BVT/GUIDE/OTHER kinds).

**Fixed columns (always present):**
- STT (45px), Tên (420px), [dynamic resource cols], Cập nhật (100px), **Trạng thái (110px), Ghi chú (220px)**.
- Trạng thái + Ghi chú are USER-OWNED columns. Render preserves them across sync.

**User-edit preservation:**
- `snapshotUserEdits(sheets, ssId, tabName, courseNode)` reads old tab values, parses header to find Trạng thái/Ghi chú columns, maps row text → lessonId via `cleanLessonName(name)` lookup against current courseTree.
- Returns `Map<lessonId, {status, note}>` passed into `buildCourseTab(opts.userEditByLessonId)`.
- Render applies these to the first row of each lesson (rows i=0).
- Bypass with `--no-preserve` (debug).

**Tab persistence (sheetId stable):**
- `ensureTab` only creates a tab when missing — existing tab keeps its sheetId, conditional formatting, protected ranges, data validation, and share `?gid=` links.
- `renameTab` changes title in-place for tab-name changes from schema updates.
- writeRichValues clears values + textFormatRuns on the write range (no leftover stale data).

### detectDriveChange — Granular Change Detection
Returns `{changed, reason, changedCourseIds, newCourseIds, removedCourseIds, teacherChanged}` instead of binary.
Used by render.js to call `crawlTeacherIncremental(drive, teacherId, [changedIds, newIds])` — only re-walks the courses that actually changed, keeping unchanged courses' subtrees from cache.

### Sync State (sync-state.js)
File format: `sync-states/<teacherId>.json`
```
{
  "tabs": {
    "<courseId>": {
      "tabName": "Khóa T",
      "renderedAt": "ISO",
      "checksum": "<courseId>|<latestModTime>|<fileCount>",
      "lessons": [
        { "id": "...", "name": "T1-A1 - ...", "parentName": "CHƯƠNG 1", "checksum": "<modTime>|<fileCount>" }
      ]
    }
  }
}
```
- `extractLessons(courseNode)` walks tree, treats depth>=1 leaves OR folders matching `^TDM[A-Z]{2}\d|^[A-Z]{1,3}\d+[-–]` as lessons.
- `diffLessons(prev, current)` → `{newLessons, changedLessons, removedLessons}` per-course.
- `diffCourse(state, courseNode, newTabName)` returns `{action: 'new'|'changed'|'skip', reason, prevTabName, lessonDiff, currentLessons}`.

### Tab Naming — Duplicate-Label Fix (2026-05-30)
- **Bug**: courses sharing a 2-word prefix (e.g. "1. VẬT LÝ 12 (2027)", "2. VẬT LÝ 11", "3. VẬT LÝ 10") all collapsed to one tab "VẬT LÝ" — `shortCourseLabel` fallback kept only first 2 words, dropping the distinguishing grade number; `ensureTab` then reused the same physical tab (last course wins, often empty).
- **Fix 1**: fallback in `shortCourseLabel` now appends a trailing numeric token if present → "VẬT LÝ 12/11/10".
- **Fix 2**: `dedupeTabNames(plan, shortenFn, prefix)` (exported) — INVARIANT-GUARANTEED uniqueness. B1) expand label via `expandLabelFromName(name, wc)` wc=3..7 words (strip number prefix + `[..]` tag, cut at `-–|:`) until colliding group distinct (e.g. "BONUS 2K8 KIẾN"/"BONUS 2K8 TOÁN"). B2) numeric suffix " (2)/(3)" for any residual collision (cross-group or identical names). B3) post-condition check THROWS if any duplicate remains (fail loud, never silently drop a tab). **All comparison is CASE-INSENSITIVE** via `tabKey(s)=lowercase+trim` because Google Sheets enforces case-insensitive tab-name uniqueness — "Khóa T" vs "KHÓA T" would otherwise pass dedup then collide at ensureTab. v2 `courseCfg.tabName` never expanded (B1) but still suffixed (B2) if needed. Called in plan build BEFORE `diffCourse`. Deterministic (crawl order stable). Verified with adversarial self-test: all-identical, case-only-diff, 10-dup, bracket, GĐ phases, bonus-prefix all PASS.
- Rename-on-sync safely handles N courses sharing one old tabName: first renames the physical tab, the rest find nothing (null) and get fresh tabs via `ensureTab`.
- **Fix 3 (bracketed category tag, teacher Trịnh Đình Thành id 1EcxStm2Bl6kajBrRjyN2MPl51wfOsfWV)**: names like "[XPS TOÁN 12] KHOÁ NỀN TẢNG", "[TOÁN 12] TOÁN THỰC TẾ...", "[TOÁN 12] BỘ CÂU HỎI..." all reduced to the leading `[...]` tag (common part), so 2+ courses collapsed to "[TOÁN 12]". `shortCourseLabel` now strips a leading `[...]` category tag (only when descriptive text follows) and labels from the text AFTER the bracket → "Khóa Nền Tảng" / "TOÁN THỰC" / "BỘ CÂU". `noPrefix` changed from const to let to allow the strip before pattern matching.

### Tab Naming — `shortCourseLabel(name)`
- Pattern 1 (KHOÁ + ...): code chữ-số `[A-Z]{1,6}\d?` → "Khóa T/E/TDMXX"; số La Mã `I/II/III/IV/V...` → "Khóa I/II"; còn lại = tên mô tả → Title Case 2-3 từ đầu (cắt ở `-–|:`), vd "KHOÁ CHUYÊN ĐỀ - Video + Live" → "Khóa Chuyên Đề", "Khóa I Vận dụng..." → "Khóa I".
- Pattern 2: `LIVE\s+([A-Z\d]{1,4})` → "LIVE I", "LIVE II"
- Pattern 3: `STEP\s+(\d{1,2})` → "STEP 1"
- Pattern 4: `VOD\s+...` → "VOD" + 2 words
- Pattern 5 (lộ trình giai đoạn/tháng, teacher Sương Mai id 1Nv_pXpXvHoZgVN8RhztDXZdxaECYgrRX): `^(GĐ\s*\d+)\s*[.\-]?\s*(T\s*\d+)` → "GĐ1.T1"…"GĐ1.T5". Đồng nhất cho cả tên có/không dấu ":" sau mã tháng ("GĐ1.T1: LỘ TRÌNH..." và "GĐ1.T5 LỘ TRÌNH..." đều ra GĐ1.Tx). Trước đây fallback cho ra "GĐ1.T1: LỘ" / "GĐ1.T5 LỘ" (lủng lẳng, không đồng nhất).
- Fallback: cắt đuôi sau dấu phân tách `-–|:/` (tránh mảnh lủng lẳng, vd "THI THỬ/ KHẢO SÁT" → "THI THỬ" thay vì "THI THỬ-"), rồi lấy 2 từ đầu + giữ token số phân biệt ngay sau.
- `titleCaseVi()` helper viết hoa chữ đầu mỗi từ (Việt hóa).
- Exported from render.js for unit testing.

### Video List Collapse (>10 videos per folder)
- `VIDEO_COLLAPSE_THRESHOLD = 10` constant in render.js.
- `collectLessonAssets()` now stores `parentId` + `parentName` on each bucket item (folder trực tiếp chứa file).
- `buildColLinks()` cột video (BG/CHUA) gom items theo `parentId`. Folder nào > 10 video → 1 link tới folder cha (`urlFolder(parentId)`, label "`<tên folder> (N video)`") thay vì list từng video. Folder ≤10 vẫn list từng link. Cột PDF (DE/KEY/BVT) không đổi.

### Orphan Tab Handling
- Course removed from Drive → `findOrphanTabs(state, currentCourseIds)` returns the entry.
- render.js renames the tab to `🗑 <oldName>` (keeps sheetId, keeps user data) instead of deleting.
- Does NOT remove from sync-state — next sync still flags it until user manually deletes.

### Key Files
- `render.js` — Stage 3: renders Google Sheet from tree + schema, snapshot+restore user-edits
- `crawl.js` — Stage 1: full crawl + `crawlTeacherIncremental(onlyCourseIds)`
- `sheet.js` — Sheet utilities: `ensureTab` (no delete), `findSheetIdByTitle`, `renameTab`, `writeRichValues`, `readTabValues`
- `sync-state.js` — course + lesson level checksums, diffLessons, extractLessons
- `auth.js` — OAuth Drive+Sheets

### File Classification (classifyFile)
| Kind | Pattern |
|------|---------|
| BG | video MIME, not CHỮA |
| CHUA | video MIME + CHỮA/LIVE.*CHỮA |
| DE | ^ĐỀ or ^DE prefix, PDF |
| KEY | ^KEY prefix |
| BVT | ^BVT_LIVE or ^BVT_ |
| GUIDE | _FCD_ or _FGC_ |
| OTHER | everything else |

### Completed Teachers
- ✅ Thầy Chí (pipeline cũ hardcode trong index.js)
- ✅ Thầy Ái TDM 2K9 (schema + render.js, 8 tab, 39 bài, 52 video)
- ✅ CHƯƠNG TRÌNH NỀN TẢNG LỚP 12 HOCMAI CÁC MÔN (multi-subject combo, 6 tabs: TOÁN/VĂN/ANH/LÝ/HÓA/SINH, schema-v2 per-course mapping, 15 bài TOÁN, 139 video)
- ⏳ Remaining 7+ Toán teachers + other subjects

### CLI Reference (render.js)
- `--teacher <id>` — required, teacher folder ID
- `--sheet <id>` — override target spreadsheet (default: auto-find inside teacher folder)
- `--dry-run` — don't write
- `--sync` — incremental: only render changed/new tabs, preserve user-edits, archive orphans
- `--list-changes` — show plan with per-tab lesson diff, no writes
- `--force-refresh` — skip change detection, force full recrawl
- `--no-auto-refresh` — skip Drive change check entirely
- `--no-preserve` — debug only: skip user-edit snapshot
- `--no-skip-meta` — include INFO/EBOOK/hướng dẫn folders
- `--schema-v2 <path>` — per-course schema override

### Lessons Learned
- Schema-v2 format allows per-course overrides (tabName, levels, structure) — stored in `schemas-v2/<teacherId>.json`. Use this for multi-subject combos or when courses need custom tab names.
- META_COURSE_PATTERNS in render.js auto-skips folders: info, thông tin, ebook, sách kèm, hướng dẫn, giới thiệu, tài liệu kèm. "lộ trình" skips only at START of name (LO_TRINH_RE). "giai đoạn" skips only if the folder is a GROUPING CONTAINER: children have grandchildren that are folders (`Array.isArray(gc.children)`). Content courses named "GIAI ĐOẠN X" are NOT skipped if their children only contain files.
- `shortenTabName()` in sheet.js trims whitespace — tab names in schema-v2 should NOT have trailing spaces
- Rich links ({text, link} → textFormatRuns) are preferred over =HYPERLINK() formula for Drive popup preview
- `cmpNumeric()` sorts by first number in name (not alphabetical) — critical for correct ordering
- `isMetaCourse()` skips INFO/EBOOK/hướng dẫn folders automatically
- Auto-detect Drive change: render.js checks modifiedTime + course count before deciding to recrawl
- **Never delete tabs**: keep sheetId so share links + user formatting survive. Use rename instead.
- **Lesson identity = lesson name** (cleaned of indent + emoji): when reading old tab back to map row→lessonId, this is the only stable key (Google Sheets has no native row-level metadata for our purposes here).
- **Sub-row Tên cells (fixed 2026-05-29)**: When a lesson has multiple files (nRows > 1), rows i>0 had blank Tên cells to the left of resource links. Fix: for i>0, find the first non-empty resource cell in that row and write `↳ <label>` (with same indent, as hyperlink) into the Tên cell. This makes sub-rows scannable without repeating the full lesson name.
- **ensureTab case-insensitive (fixed 2026-05-30)**: Google Sheets enforces case-insensitive tab name uniqueness. Pre-existing "KHÓA T" conflicted with our generated "Khóa T". Fix: use `.toLowerCase()` comparison in ensureTab for both initial check and retry. Always use case-insensitive match when looking up existing sheet tabs.
