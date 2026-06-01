# Tiến Trình Drive-to-Sheet

## Trạng Thái Hiện Tại

- Backend Node pipeline đã chạy production ổn định.
- Run mới nhất được kiểm: `no-meta-sync-2026-05-31-104541`.
- Kết quả run đó: 34 ready, 34 OK, 0 failed, 0 skipped.
- Test offline: `npm test --prefix tool`.
- Smoke test live/read-only: `node tool/test-smoke.js`.

## Pipeline

1. `crawl.js`
   - Crawl cây thư mục Drive vào `tool/trees/<teacherId>.json`.
   - Có `--force`, `--max-age`, và incremental crawl cho course đổi.

2. Schema
   - Legacy schema: `tool/schemas/<teacherId>.json`.
   - Schema v2 theo course: `tool/schemas-v2/<teacherId>.json`.
   - `infer-schema.js` validate schema trước khi render.

3. `render.js`
   - Ghi một Google Sheet đã có sẵn.
   - Không tạo spreadsheet mới.
   - Preserve cột user-owned: `Trạng thái`, `Ghi chú`.
   - Ghi rich links thay vì `=HYPERLINK`.
   - Verify sau ghi rồi mới lưu sync-state.

4. `sync-many.js`
   - Chạy nhiều giáo viên theo `all-pairs.json`.
   - Mặc định preview khi không có `--sync`.
   - Khi `--sync`, mặc định tạo backup copy trước khi ghi.

5. `backup.js`
   - `--sheet <id>` tạo Drive copy của spreadsheet.
   - `--restore --backup <id> --target <id> --yes` rollback target từ backup.

## Những Fix Quan Trọng Đã Có

- Retry và pacing cho Google Sheets write quota.
- Deduplicate tab name case-insensitive trước khi tính diff.
- Giữ sheetId khi rename tab để không phá link `gid`.
- Archive orphan tabs bằng rename thay vì delete.
- Hidden `_lesson_id` để preserve user edits ổn định hơn legacy name fallback.
- Post-write readback verification.

## Quy Trình Khuyến Nghị

```powershell
cd C:\Users\giaos\.claude\agents
npm test --prefix tool
node tool\test-smoke.js
node tool\sync-many.js --list-changes --run-id preflight-YYYYMMDD
node tool\sync-many.js --sync --run-id sync-YYYYMMDD
```

Nếu một run đụng quota hoặc network reset, dùng `--resume <run-id>` để tiếp tục những pair chưa OK.
