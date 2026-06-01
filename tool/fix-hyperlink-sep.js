// Fix HYPERLINK separator , → ; cho mọi cell formula trên 1 spreadsheet.
// Chỉ đụng cell có formula =HYPERLINK(...). KHÔNG đụng cell text/value khác.
//
// CLI:
//   node fix-hyperlink-sep.js --sheet <id>             # preview (dry-run)
//   node fix-hyperlink-sep.js --sheet <id> --apply     # ghi thật

const { getClients } = require('./auth');

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet' || a === '-s') out.spreadsheetId = argv[++i];
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

// Match =HYPERLINK("...","...") nhưng KHÔNG match đã dùng ;
// Tránh đụng formula khác có chứa string với dấu ,
const RE_HYPERLINK_COMMA = /^=HYPERLINK\("([^"]*)"\s*,\s*"([^"]*)"\)$/i;

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
  const tabs = meta.data.sheets || [];
  console.log(`Spreadsheet: ${meta.data.properties.title}`);
  console.log(`  ${tabs.length} tab\n`);

  let totalFix = 0;
  const updates = [];

  for (const t of tabs) {
    const title = t.properties.title;
    const rows = t.properties.gridProperties.rowCount;
    const cols = t.properties.gridProperties.columnCount;

    const range = `'${title}'!A1:${colLetter(cols - 1)}${rows}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: args.spreadsheetId,
      range,
      valueRenderOption: 'FORMULA',
    });
    const grid = res.data.values || [];
    let fixInTab = 0;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (typeof v !== 'string') continue;
        const m = RE_HYPERLINK_COMMA.exec(v);
        if (!m) continue;
        const url = m[1];
        const label = m[2];
        const fixed = `=HYPERLINK("${url}";"${label}")`;
        const a1 = `'${title}'!${colLetter(c)}${r + 1}`;
        updates.push({ range: a1, values: [[fixed]] });
        fixInTab++;
      }
    }
    if (fixInTab > 0) {
      console.log(`  [${title}] ${fixInTab} cell cần fix`);
      totalFix += fixInTab;
    }
  }

  console.log(`\nTổng: ${totalFix} cell HYPERLINK dùng dấu , (locale en)`);

  if (totalFix === 0) {
    console.log('Không có gì để fix.');
    return;
  }

  if (!args.apply) {
    console.log('\n[DRY-RUN] Thêm --apply để ghi thật.');
    // In 5 sample
    console.log('\nSample (5 cell đầu):');
    for (const u of updates.slice(0, 5)) {
      console.log(`  ${u.range} → ${u.values[0][0].slice(0, 100)}`);
    }
    return;
  }

  // Apply theo batch 500 cell mỗi lần để tránh request quá to
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: args.spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: slice,
      },
    });
    console.log(`  Đã ghi ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }
  console.log('\n✓ Hoàn tất.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('LỖI:', e.message);
    if (e.response && e.response.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  });
}
