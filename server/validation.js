const { httpError } = require('./access');
const { todayLocal, dateLocalOffset } = require('./util');
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dateRange(start = dateLocalOffset(-30), end = todayLocal()) {
  if (!validDate(start) || !validDate(end) || start > end) throw httpError(400, '日期须为有效 YYYY-MM-DD，开始日期不能晚于结束日期');
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > 366) throw httpError(400, '每次最多查询 367 天');
  return { start, end };
}
function reportInput(body, types) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw httpError(400, '名称须为 1–120 个字符');
  if (!Object.hasOwn(types, body.report_type)) throw httpError(400, '不支持的报表类型');
  if (body.file_format !== undefined && !['csv', 'json'].includes(body.file_format)) throw httpError(400, '仅支持 csv/json 格式');
}
module.exports = { validDate, dateRange, reportInput };
