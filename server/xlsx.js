// ===== Excel 导出（SpreadsheetML 2003，零依赖，Excel/WPS 可打开）=====
function xmlEscape(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function cell(v) {
  if (v === null || v === undefined || v === '') return '<Cell/>';
  const isNum = typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
  if (isNum) return `<Cell><Data ss:Type="Number">${Number(v)}</Data></Cell>`;
  return `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`;
}

// columns: [{ key, label }] 或 ['key']
function toSpreadsheetML(sheetName, columns, rows) {
  const cols = columns.map(c => (typeof c === 'string' ? { key: c, label: c } : c));
  const header = cols.map(c => `<Cell ss:StyleID="h"><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`).join('');
  const body = rows.map(r => `<Row>${cols.map(c => cell(r[c.key])).join('')}</Row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>
<Worksheet ss:Name="${xmlEscape(sheetName).slice(0, 31)}"><Table><Row>${header}</Row>${body}</Table></Worksheet>
</Workbook>`;
}

module.exports = { toSpreadsheetML, xmlEscape };
