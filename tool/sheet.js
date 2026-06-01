const { withRetry } = require('./utils');

function tabTitleKey(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function sheetRangeName(title) {
  return `'${String(title || '').replace(/'/g, "''")}'`;
}

function shortenTabName(raw, maxLen = 90) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\d+\.\s*/, '');
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.replace(/[\\/?*\[\]:]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s || 'TAB';
}

function appendTabNameSuffix(raw, suffix, maxLen = 90) {
  const cleanSuffix = String(suffix || '').trim();
  const base = shortenTabName(raw, maxLen);
  if (!cleanSuffix) return base;
  const decoratedSuffix = ` ${cleanSuffix}`;
  const baseBudget = Math.max(1, maxLen - decoratedSuffix.length);
  const shortenedBase = shortenTabName(base, baseBudget);
  return shortenTabName(`${shortenedBase}${decoratedSuffix}`, maxLen);
}

async function getSpreadsheet(sheets, spreadsheetId) {
  const res = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId, includeGridData: false }),
    { context: `get spreadsheet ${spreadsheetId}` },
  );
  return res.data;
}

// Đảm bảo tab tồn tại với title cho trước. Trả về sheetId.
//
// QUAN TRỌNG: Khi tab đã tồn tại, GIỮ NGUYÊN sheetId thay vì delete-và-recreate.
// Lý do:
//   - Link share dạng `?gid=<sheetId>` của user vẫn hoạt động
//   - Format/width/frozen rows do user chỉnh tay được giữ (đến khi
//     applyTabFormatting overwrite phần mình quản lý)
//   - Conditional formatting, data validation, protected ranges không bị xóa
//
// writeRichValues sẽ tự clear values + textFormatRuns trên range cần ghi nên
// không lo dữ liệu cũ "lậu" vào.
async function ensureTab(sheets, spreadsheetId, title) {
  // Google Sheets uses case-insensitive name uniqueness, so match the same way.
  // E.g. "KHOA T" (manually pre-existing) conflicts with our generated "Khoa T".
  const targetKey = tabTitleKey(title);
  const matchTitle = (t) => tabTitleKey(t) === targetKey;

  const meta = await getSpreadsheet(sheets, spreadsheetId);
  const existing = (meta.sheets || []).find((s) => matchTitle(s.properties.title));
  if (existing) {
    return existing.properties.sheetId;
  }
  try {
    const addRes = await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    }), { context: `add sheet ${title}` });
    return addRes.data.replies[0].addSheet.properties.sheetId;
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('already exists')) {
      const retry = await getSpreadsheet(sheets, spreadsheetId);
      const found = (retry.sheets || []).find((s) => matchTitle(s.properties.title));
      if (found) return found.properties.sheetId;
    }
    throw err;
  }
}

// Lấy sheetId theo title (null nếu không tồn tại). Dùng để snapshot tab cũ
// trước khi render lại.
async function findSheetIdByTitle(sheets, spreadsheetId, title) {
  const meta = await getSpreadsheet(sheets, spreadsheetId);
  const targetKey = tabTitleKey(title);
  const found = (meta.sheets || []).find((s) => tabTitleKey(s.properties.title) === targetKey);
  return found ? found.properties.sheetId : null;
}

// Đổi tên tab (giữ sheetId). Dùng cho orphan archive.
async function renameTab(sheets, spreadsheetId, sheetId, newTitle) {
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, title: newTitle },
          fields: 'title',
        },
      }],
    },
  }), { context: `rename sheet ${sheetId}` });
}

async function writeValues(sheets, spreadsheetId, title, values) {
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetRangeName(title)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  }), { context: `write values ${title}` });
}

// Cell rich link: {text, link} → string cell + textFormatRuns gắn link.uri.
// Sheets sẽ nhận diện URL Drive → hiện popup preview khi hover (smart chip card).
// Cell thường (string/number/boolean) ghi như stringValue/numberValue/boolValue.
// Cell formula (chuỗi bắt đầu '=') ghi qua formulaValue.
function buildCellData(v) {
  if (v && typeof v === 'object' && typeof v.text === 'string' && typeof v.link === 'string') {
    const text = v.text;
    return {
      userEnteredValue: { stringValue: text },
      textFormatRuns: [
        { startIndex: 0, format: { link: { uri: v.link }, foregroundColor: { red: 0.066, green: 0.333, blue: 0.8 }, underline: true } },
      ],
    };
  }
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v }, textFormatRuns: null };
  if (typeof v === 'boolean') return { userEnteredValue: { boolValue: v }, textFormatRuns: null };
  const s = v == null ? '' : String(v);
  if (s.startsWith('=')) return { userEnteredValue: { formulaValue: s }, textFormatRuns: null };
  return { userEnteredValue: { stringValue: s }, textFormatRuns: null };
}

// Ghi 2D array values (cell có thể là string/number/{text,link}/'=formula') vào tab
// thông qua updateCells request. Khác writeValues ở chỗ:
//   - cell {text, link} → rich link (popup Drive preview hover được)
//   - clear textFormatRuns cho các cell khác để không kế thừa link cũ
// Chunk theo số dòng để tránh request quá to (mặc định 400 row/chunk).
function rangesOverlap(a, b) {
  const aStartRow = a.startRowIndex || 0;
  const aEndRow = a.endRowIndex == null ? Number.POSITIVE_INFINITY : a.endRowIndex;
  const aStartCol = a.startColumnIndex || 0;
  const aEndCol = a.endColumnIndex == null ? Number.POSITIVE_INFINITY : a.endColumnIndex;
  const bStartRow = b.startRowIndex || 0;
  const bEndRow = b.endRowIndex == null ? Number.POSITIVE_INFINITY : b.endRowIndex;
  const bStartCol = b.startColumnIndex || 0;
  const bEndCol = b.endColumnIndex == null ? Number.POSITIVE_INFINITY : b.endColumnIndex;
  return aStartRow < bEndRow && aEndRow > bStartRow && aStartCol < bEndCol && aEndCol > bStartCol;
}

async function unmergeOverlappingCells(sheets, spreadsheetId, sheetId, writeRange) {
  const meta = await getSpreadsheet(sheets, spreadsheetId);
  const sheet = (meta.sheets || []).find((s) => s.properties.sheetId === sheetId);
  const merges = (sheet && sheet.merges) || [];
  const requests = merges
    .filter((range) => rangesOverlap(range, writeRange))
    .map((range) => ({ unmergeCells: { range } }));
  if (!requests.length) return;
  await withRetry(
    () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    { context: `unmerge sheet ${sheetId}` },
  );
}

async function writeRichValues(sheets, spreadsheetId, sheetId, values, opts) {
  const chunkRows = (opts && opts.chunkRows) || 400;
  const ncol = values.reduce((m, r) => Math.max(m, (r || []).length), 0);
  const clearCols = Math.max(ncol, (opts && opts.clearColumns) || 26);
  const clearRows = Math.max(values.length, (opts && opts.clearRows) || values.length + 25);
  const writeRange = { sheetId, startRowIndex: 0, endRowIndex: clearRows, startColumnIndex: 0, endColumnIndex: clearCols };
  await unmergeOverlappingCells(sheets, spreadsheetId, sheetId, writeRange);
  // Clear toàn bộ value + format trên range trước (an toàn khi tab tái sử dụng)
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: writeRange,
          fields: 'userEnteredValue,textFormatRuns',
        },
      }],
    },
  }), { context: `clear rich values ${sheetId}` });
  for (let r0 = 0; r0 < values.length; r0 += chunkRows) {
    const slice = values.slice(r0, r0 + chunkRows);
    const requests = [{
      updateCells: {
        start: { sheetId, rowIndex: r0, columnIndex: 0 },
        rows: slice.map((row) => ({ values: (row || []).map(buildCellData) })),
        fields: 'userEnteredValue,textFormatRuns',
      },
    }];
    await withRetry(
      () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
      { context: `write rich values ${sheetId} rows ${r0 + 1}-${r0 + slice.length}` },
    );
  }
}

async function applyHeaderFormat(sheets, spreadsheetId, sheetId, headerColCount) {
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerColCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.18, green: 0.46, blue: 0.71 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: headerColCount },
          },
        },
      ],
    },
  }), { context: `apply header format ${sheetId}` });
}

// Đọc bảng giá trị thô (chỉ string, không link) của 1 tab. Dùng để snapshot
// các cột user-edited (Trạng thái, Ghi chú) trước khi render lại.
// Trả về 2D array, mỗi cell là string (rỗng nếu trống).
async function readTabValues(sheets, spreadsheetId, title) {
  try {
    const res = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRangeName(title),
      valueRenderOption: 'UNFORMATTED_VALUE',
    }), { context: `read tab values ${title}` });
    return res.data.values || [];
  } catch (_) {
    return [];
  }
}

function columnLetter(indexZeroBased) {
  let n = indexZeroBased + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getSheetById(sheets, spreadsheetId, sheetId, opts = {}) {
  const res = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: !!opts.includeGridData,
    ranges: opts.ranges,
  }), { context: `get sheet ${sheetId}` });
  return (res.data.sheets || []).find((s) => s.properties && s.properties.sheetId === sheetId) || null;
}

async function hideColumn(sheets, spreadsheetId, sheetId, columnIndex) {
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      }],
    },
  }), { context: `hide column ${columnIndex + 1} sheet ${sheetId}` });
}

function cellTextFromData(cell) {
  if (!cell || !cell.userEnteredValue) return '';
  const v = cell.userEnteredValue;
  if (v.stringValue != null) return String(v.stringValue);
  if (v.numberValue != null) return String(v.numberValue);
  if (v.boolValue != null) return String(v.boolValue);
  if (v.formulaValue != null) return String(v.formulaValue);
  return '';
}

async function verifyRenderedTab(sheets, spreadsheetId, sheetId, built, opts = {}) {
  const errors = [];
  const warnings = [];
  const lessonIdCol = built.NCOL - 1;
  const titleMeta = await getSheetById(sheets, spreadsheetId, sheetId, { includeGridData: false });
  if (!titleMeta) {
    return { ok: false, errors: [`sheetId ${sheetId} not found`], warnings };
  }

  const title = titleMeta.properties.title;
  const maxRows = Math.max(2, Math.min((built.rows || []).length, opts.maxRows || 60));
  const range = `${sheetRangeName(title)}!A1:${columnLetter(lessonIdCol)}${maxRows}`;
  const sheet = await getSheetById(sheets, spreadsheetId, sheetId, { includeGridData: true, ranges: [range] });
  if (!sheet) {
    return { ok: false, errors: [`sheetId ${sheetId} not found during grid readback`], warnings };
  }

  const props = sheet.properties || {};
  const gridProps = props.gridProperties || {};
  const expectedFrozen = ((built.styles && built.styles.headerRow) || 0) + 1;
  if ((gridProps.frozenRowCount || 0) < expectedFrozen) {
    errors.push(`frozenRowCount ${gridProps.frozenRowCount || 0} < ${expectedFrozen}`);
  }

  const data = (sheet.data && sheet.data[0]) || {};
  const rows = data.rowData || [];
  const headerValues = ((rows[(built.styles && built.styles.headerRow) || 1] || {}).values || []);
  const lessonIdHeader = cellTextFromData(headerValues[lessonIdCol]);
  if (lessonIdHeader !== '_lesson_id') errors.push(`missing _lesson_id header at column ${columnLetter(lessonIdCol)}`);

  const colMeta = data.columnMetadata || [];
  if (!((colMeta[lessonIdCol] || {}).hiddenByUser)) {
    errors.push(`_lesson_id column ${columnLetter(lessonIdCol)} is not hidden`);
  }

  let formulaHyperlinks = 0;
  let richLinks = 0;
  for (const row of rows) {
    for (const cell of (row.values || [])) {
      const formula = cell && cell.userEnteredValue && cell.userEnteredValue.formulaValue;
      if (formula && /^=HYPERLINK/i.test(String(formula))) formulaHyperlinks++;
      if (Array.isArray(cell && cell.textFormatRuns) && cell.textFormatRuns.some((run) => run.format && run.format.link && run.format.link.uri)) {
        richLinks++;
      }
    }
  }
  if (formulaHyperlinks) errors.push(`found ${formulaHyperlinks} HYPERLINK formulas`);

  const expectedRichLinks = (built.rows || []).some((row) => (row || []).some((cell) => cell && typeof cell === 'object' && cell.link));
  if (expectedRichLinks && richLinks === 0) warnings.push('no rich links observed in sampled readback');

  return { ok: errors.length === 0, errors, warnings, title };
}

module.exports = {
  shortenTabName,
  appendTabNameSuffix,
  getSpreadsheet,
  ensureTab,
  findSheetIdByTitle,
  renameTab,
  writeValues,
  writeRichValues,
  readTabValues,
  applyHeaderFormat,
  hideColumn,
  verifyRenderedTab,
  columnLetter,
  sheetRangeName,
};
