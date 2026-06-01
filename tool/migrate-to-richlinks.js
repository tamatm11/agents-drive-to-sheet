// Convert mọi cell =HYPERLINK("url"; "label") sang rich link cell
// (textFormatRuns + link.uri) để Sheets hiện popup preview Drive khi hover.
//
// Lý do: cell formula HYPERLINK chỉ là link click-được, KHÔNG kích hoạt
// "smart chip preview" của Google Drive khi hover (vì Sheets không phân tích
// URL trong formula). Cell rich link với link.uri thì có.
//
// CLI:
//   node migrate-to-richlinks.js --sheet <id>             # preview (dry-run)
//   node migrate-to-richlinks.js --sheet <id> --apply     # ghi thật
//   node migrate-to-richlinks.js --sheet <id> --apply --tab "Khóa TDMTL"

const { getClients } = require('./auth');

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet' || a === '-s') out.spreadsheetId = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--tab') out.onlyTab = argv[++i];
  }
  return out;
}

// Match =HYPERLINK("url"; "label") hoặc =HYPERLINK("url", "label")
// (sau lần fix trước đa số đã ;, nhưng phòng trường hợp còn ,)
const RE_HYPERLINK = /^=HYPERLINK\("([^"]*)"\s*[;,]\s*"((?:[^"\\]|\\.)*)"\)$/i;

function colLetter(idx) {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.spreadsheetId) {
    console.error('Thiếu --sheet <id>');
    process.exit(1);
  }
  const { sheets } = getClients();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: args.spreadsheetId,
    includeGridData: false,
  });
  const tabs = (meta.data.sheets || []).filter((t) => !args.onlyTab || t.properties.title === args.onlyTab);
  console.log(`Spreadsheet: ${meta.data.properties.title}`);
  console.log(`  ${tabs.length} tab${args.onlyTab ? ` (lọc theo --tab ${args.onlyTab})` : ''}\n`);

  let totalCells = 0;
  // Mỗi tab: gom thành 1 updateCells request lớn theo từng row chunk
  const requests = [];

  for (const t of tabs) {
    const title = t.properties.title;
    const sheetId = t.properties.sheetId;
    const rows = t.properties.gridProperties.rowCount;
    const cols = t.properties.gridProperties.columnCount;
    const range = `'${title}'!A1:${colLetter(cols - 1)}${rows}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: args.spreadsheetId,
      range,
      valueRenderOption: 'FORMULA',
    });
    const grid = res.data.values || [];
    let countTab = 0;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (typeof v !== 'string') continue;
        const m = RE_HYPERLINK.exec(v);
        if (!m) continue;
        const url = m[1];
        const label = m[2].replace(/""/g, '"');
        countTab++;
        // updateCells từng cell — request body có textFormatRuns + link.uri
        requests.push({
          updateCells: {
            range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: c, endColumnIndex: c + 1 },
            rows: [{
              values: [{
                userEnteredValue: { stringValue: label },
                textFormatRuns: [{
                  startIndex: 0,
                  format: { link: { uri: url }, foregroundColor: { red: 0.066, green: 0.333, blue: 0.8 }, underline: true },
                }],
              }],
            }],
            fields: 'userEnteredValue,textFormatRuns',
          },
        });
      }
    }
    if (countTab > 0) {
      console.log(`  [${title}] ${countTab} cell HYPERLINK → rich link`);
      totalCells += countTab;
    }
  }

  console.log(`\nTổng: ${totalCells} cell cần migrate`);
  if (totalCells === 0) {
    console.log('Không có gì để fix.');
    return;
  }
  if (!args.apply) {
    console.log('\n[DRY-RUN] Thêm --apply để ghi thật.');
    return;
  }

  const CHUNK = 200;
  for (let i = 0; i < requests.length; i += CHUNK) {
    const slice = requests.slice(i, i + CHUNK);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: args.spreadsheetId,
      requestBody: { requests: slice },
    });
    console.log(`  Đã ghi ${Math.min(i + CHUNK, requests.length)}/${requests.length} cell`);
  }
  console.log('\n✓ Hoàn tất. Hover cell sẽ thấy popup preview Drive.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('LỖI:', e.message);
    if (e.response && e.response.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  });
}
