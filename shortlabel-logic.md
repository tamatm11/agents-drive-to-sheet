# shortLabel Logic - Descriptive Video Labels

**Updated:** 2026-05-29  
**Location:** `C:\Users\giaos\.claude\agents\tool\render.js` (lines ~339-379)

## Strategy

When a lesson has multiple files of the same kind:
- **VIDEO (BG, CHUA)**: Show full descriptive names → students know what each video covers
- **PDF (DE, KEY, BVT, OTHER)**: Keep short labels → sheet stays clean and scannable

## Implementation

### BG (Bài giảng) - Video Lectures

```javascript
if (kind === 'BG') {
  const name = file && file.name || '';
  if (total && total > 1) {
    // Pattern: "Bg01. Khoảng cách cơ bản.mp4" → "Bg01. Khoảng cách cơ bản"
    const m = /Bg\s*0?(\d{1,2})[.\s]*(.+)/i.exec(name);
    if (m) {
      const num = m[1].padStart(2, '0');
      const desc = m[2].replace(/\.(mp4|avi|mkv|mov)$/i, '').trim();
      const shortDesc = desc.length > 45 ? desc.slice(0, 42) + '...' : desc;
      return `Bg${num}. ${shortDesc}`;
    }
    // Fallback: use cleaned filename
    const cleanName = name.replace(/\.(mp4|avi|mkv|mov)$/i, '').trim();
    return cleanName.length > 45 ? cleanName.slice(0, 42) + '...' : cleanName;
  }
  // Single video → short label
  const m = /Bg\s*0?(\d{1,2})/i.exec(name);
  if (m) return `Bg${m[1].padStart(2, '0')}`;
  return 'Bài giảng';
}
```

**Examples:**
- Multiple: `Bg01. Khoảng cách cơ bản.mp4` → **"Bg01. Khoảng cách cơ bản"**
- Multiple: `Bg02. KN triển khai bài toán mô hình KC.mp4` → **"Bg02. KN triển khai bài toán mô hình KC"**
- Single: `Bg01. Nội dung.mp4` → **"Bg01"**

### CHUA (Chữa đề) - Solution Videos

```javascript
if (kind === 'CHUA') {
  const name = file && file.name || '';
  if (total && total > 1) {
    // Strip prefix, show description
    const cleanName = name
      .replace(/\.(mp4|avi|mkv|mov|pdf)$/i, '')
      .replace(/^(CH[ỮU]A|LIVE.*CH[ỮU]A)[.\s_-]*/i, '')
      .trim();
    if (cleanName && cleanName.length > 3) {
      const shortName = cleanName.length > 40 ? cleanName.slice(0, 37) + '...' : cleanName;
      return part ? `Chữa ${part}: ${shortName}` : `Chữa: ${shortName}`;
    }
  }
  if (part) return `Chữa ${part}`;
  if (total && total > 1) return `Chữa ${idx || 1}`;
  return 'Chữa đề';
}
```

**Examples:**
- Multiple: `Chữa ĐTL Phần A.mp4` → **"Chữa: ĐTL Phần A"**
- Multiple: `LIVE Chữa đề thi thử lần 1.mp4` → **"Chữa: đề thi thử lần 1"**
- Single: → **"Chữa đề"**

### DE, KEY, BVT, OTHER - Short Labels (unchanged)

```javascript
// DE (Đề tự luyện)
if (kind === 'DE') {
  if (part) return `Đề ${part}`;
  if (total && total > 1) return `Đề ${idx || 1}`;
  return 'Đề';
}

// KEY (Check Key)
if (kind === 'KEY') {
  if (part) return `Key ${part}`;
  if (total && total > 1) return `Key ${idx || 1}`;
  return 'Key';
}

// BVT (Bản viết tay)
if (kind === 'BVT') {
  const name = file && file.name || '';
  const m = /BVT[_\s]*(LIVE)?[_\s]*(\d+)?/i.exec(name);
  if (m && m[2]) return `BVT ${m[2]}`;
  if (total && total > 1) return `BVT ${idx || 1}`;
  return 'BVT';
}

// OTHER (Tài liệu khác)
if (total && total > 1) return `Tài liệu ${idx || 1}`;
return 'Tài liệu';
```

**Examples:**
- Multiple DE: "Đề 1", "Đề 2", "Đề 3" or "Đề A", "Đề B" (with part)
- Multiple KEY: "Key 1", "Key 2" or "Key A", "Key B"
- Multiple BVT: "BVT 1", "BVT 2" or "BVT 01", "BVT 02"
- Multiple OTHER: "Tài liệu 1", "Tài liệu 2"

## Length Limits

| Kind | Max Length | Truncate |
|------|-----------|----------|
| BG | 45 chars | "..." |
| CHUA | 40 chars | "..." |
| DE, KEY, BVT, OTHER | N/A (short labels) | N/A |

## Pattern Matching

| Kind | Regex | Purpose |
|------|-------|---------|
| BG | `/Bg\s*0?(\d{1,2})[.\s]*(.+)/i` | Extract number + description |
| CHUA | `/^(CH[ỮU]A|LIVE.*CH[ỮU]A)[.\s_-]*/i` | Strip prefix |
| BVT | `/BVT[_\s]*(LIVE)?[_\s]*(\d+)?/i` | Extract number |

## Rationale

### Why descriptive for videos?
- Videos are the main learning content
- Students need to know which video teaches what
- Avoids clicking through multiple videos to find the right one
- Example: Lesson has 3 videos about "Khoảng cách" → students immediately see video 1 is basics, video 2 is advanced, video 3 is examples

### Why short for PDFs?
- PDFs are supplementary materials
- Students typically download all of them
- Long names clutter the sheet and make it hard to scan
- Generic labels "Đề 1, 2, 3" are sufficient to distinguish

## Example Output

Lesson TDMXX01 with 3 BG videos + 2 DE PDFs + 1 KEY:

```
| STT | Tên Bài | Bài giảng | Đề | Key | Trạng thái | Ghi chú |
|-----|---------|-----------|-----|-----|------------|---------|
| 1 | TDMXX01 - Khoảng cách | Bg01. Khoảng cách cơ bản | Đề 1 | Key 1 | | |
|   |  | Bg02. KN triển khai bài toán mô hình KC | Đề 2 | | | |
|   |  | Bg03. Một số VD triển khai BT | | | | |
```

**Result:**
- ✅ Students see video content at a glance
- ✅ PDF columns stay compact
- ✅ Sheet is readable and scannable
- ✅ User-edit columns (Trạng thái, Ghi chú) preserved

## Testing

Test file: `C:\Users\giaos\.claude\agents\tool\test-labels.js` (temporary, deleted after verification)

Verified with actual data from Thầy Ái TDM 2K9:
- Lesson TDMXX01: 3 BG videos → all show descriptive names
- Lesson TDMXX02: 2 BG videos + PDFs → videos descriptive, PDFs short
- Single-video lessons → unchanged (backward compatible)

## Backward Compatibility

✅ Single-file lessons unchanged (still show "Bài giảng", "Đề", "Key")  
✅ PDF labels unchanged (no visual disruption)  
✅ Only multi-video lessons get improved labels  
✅ User-edit columns preserved during re-render  
✅ No breaking changes to schema or data structure

## Apply to Existing Sheets

```bash
# Preview changes
node render.js --teacher <teacherId> --list-changes

# Apply incrementally (only changed tabs, preserve user edits)
node render.js --teacher <teacherId> --sync
```
