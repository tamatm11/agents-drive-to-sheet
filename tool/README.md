# Drive to Sheet Tool

Backend Node.js cho agent `adaptive-drive-to-sheet`. Tool này đọc cây thư mục Google Drive của giáo viên, dựng schema bài học, rồi ghi các tab bài học vào Google Sheet đã có sẵn.

## Môi Trường

- Node.js >= 18.
- OAuth files:
  - `C:/Users/giaos/.claude/credentials.json`
  - `C:/Users/giaos/.claude/token.json`
- Có thể override bằng:
  - `GDRIVE_CREDENTIALS`
  - `GDRIVE_TOKEN`

Workflow hiện tại chạy trên Claude/Codex, không cần Gemini API key. ADK/Gemini eval chỉ là tùy chọn nếu sau này chạy wrapper `app/` bằng `agents-cli`.

## Lệnh Chính

```powershell
cd C:\Users\giaos\.claude\agents

# Test offline
npm test --prefix tool

# Smoke test auth + cache + schema, không ghi sheet
node tool\test-smoke.js

# Xem trước toàn bộ thay đổi, không ghi
node tool\sync-many.js --list-changes --run-id preflight-20260531

# Sync toàn bộ sheet đã sẵn sàng. Mặc định tạo backup trước mỗi sheet.
node tool\sync-many.js --sync --run-id sync-20260531

# Nếu thật sự muốn bỏ backup
node tool\sync-many.js --sync --no-backup --run-id sync-20260531
```

## Một Giáo Viên

```powershell
# Preview một giáo viên
node tool\render.js --teacher <TEACHER_FOLDER_ID> --sheet <SPREADSHEET_ID> --list-changes

# Sync một giáo viên
node tool\render.js --teacher <TEACHER_FOLDER_ID> --sheet <SPREADSHEET_ID> --sync

# Readback verify, không ghi
node tool\render.js --teacher <TEACHER_FOLDER_ID> --sheet <SPREADSHEET_ID> --verify-only
```

## Backup Và Rollback

`sync-many.js --sync` mặc định copy nguyên Google Sheet trước khi ghi. Backup được tạo cùng thư mục Drive với sheet nguồn và được log trong `tool/run-logs/<run-id>.jsonl`.

Tạo backup thủ công:

```powershell
node tool\backup.js --sheet <SPREADSHEET_ID> --run-id manual-before-sync
```

Rollback target sheet từ backup:

```powershell
node tool\backup.js --restore --backup <BACKUP_SPREADSHEET_ID> --target <TARGET_SPREADSHEET_ID> --yes
```

Rollback là thao tác phá hủy nội dung hiện tại của target spreadsheet: tool sẽ xóa các tab hiện có trong target, copy tab từ backup sang, rồi đặt lại tên tab như backup. Vì vậy lệnh bắt buộc có `--yes`.

Lưu ý: rollback giữ nguyên spreadsheet ID của target, nhưng các tab được copy lại sẽ có `gid` mới. Nếu cần giữ nguyên cả `gid` cũ để đối chiếu, mở trực tiếp file backup.

## Cấu Trúc

- `auth.js`: OAuth Drive + Sheets, có pacing/retry cho Sheets write quota.
- `crawl.js`: crawl Drive vào `tool/trees/<teacherId>.json`.
- `infer-schema.js`: load/validate schema trong `tool/schemas/<teacherId>.json`.
- `render.js`: render tab bài học, preserve user edits, verify sau ghi.
- `sync-many.js`: chạy preview/sync nhiều giáo viên theo manifest pair.
- `backup.js`: copy sheet backup và rollback từ backup.
- `sheet.js`: helper Google Sheets.
- `sync-state.js`: checkpoint course/tab/lesson.
- `lesson-model.js`: nhận diện lesson/resource.

## Quy Trình An Toàn

1. Chạy `npm test --prefix tool`.
2. Chạy `node tool\test-smoke.js`.
3. Chạy `node tool\sync-many.js --list-changes --run-id <id>`.
4. Nếu preview sạch, chạy `node tool\sync-many.js --sync --run-id <id>`.
5. Nếu có `preserveRisks`, dừng lại và đọc log trước khi dùng `--allow-preserve-risk`.

## Lưu Ý Quota

Google Sheets giới hạn write theo phút trên mỗi user. `auth.js` đã có delay/retry cho write requests, nhưng batch lớn vẫn nên chạy tuần tự qua `sync-many.js` và giữ backup bật.
