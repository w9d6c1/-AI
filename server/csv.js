// ===== 轻量 CSV 解析/序列化（零依赖）=====
// 支持：引号包裹、字段内逗号/换行、双引号转义("")、CRLF/LF、UTF-8 BOM。
// 用于采集器导入模板与导出执行清单。

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 解析为二维数组
function parseRows(text) {
  const src = stripBom(String(text ?? ''));
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // 末行（无换行结尾）
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

// 解析为对象数组（首行为表头）
function parseCsv(text) {
  const rows = parseRows(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const obj = { __row: idx + 2 };
    headers.forEach((h, i) => { obj[h] = r[i] === undefined ? '' : r[i].trim(); });
    return obj;
  });
  return { headers, records };
}

function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 序列化：rows 为对象数组，columns 为 { key, label } 或字符串数组
function toCsv(rows, columns) {
  const cols = columns.map(c => (typeof c === 'string' ? { key: c, label: c } : c));
  const lines = [cols.map(c => escapeCell(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map(c => escapeCell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, parseRows, toCsv, escapeCell };
