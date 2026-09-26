const { test } = require('node:test');
const assert = require('node:assert/strict');
const { definitions, getWorkbench, validateRequest, normalizeResult } = require('../server/agent-workbench');
const { fallback } = require('../server/agent-fallbacks');

test('工作台契约：核心 9 个智能体均有专属输入和输出', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'a17'];
  for (const id of ids) {
    const c = getWorkbench(id);
    assert.ok(c, id);
    assert.ok(c.fields.length >= 1, id);
    assert.ok(c.resultKey, id);
    assert.equal(c.supportsExport, true);
  }
  assert.equal(getWorkbench('a17').type, 'copy');
  assert.equal(getWorkbench('a9').type, 'image');
});

test('工作台参数校验：拒绝空输入、错误枚举和过长内容', () => {
  assert.throws(() => validateRequest('a17', {}), /请输入商品名称/);
  assert.throws(() => validateRequest('a17', { input: '商品', options: { platform: '不存在的平台' } }), /目标平台选项不正确/);
  assert.throws(() => validateRequest('a17', { input: '商品', options: { count: 99 } }), /生成版本数须为/);
  assert.throws(() => validateRequest('a17', { input: '商品', extra: 'x'.repeat(12001) }), /补充说明不能超过/);
  const request = validateRequest('a17', { input: '商品', extra: '真实要求', options: { contentType: '商品卖点', count: 2 } });
  assert.equal(request.options.count, 2);
});

test('离线模板：文案和标题遵守数量、长度并保留数据边界', () => {
  const copy = fallback('a17', '便携咖啡杯', { contentType: '商品卖点', count: 2, maxLength: 80, sellingPoints: '容量 350ml\n可拆洗杯盖', scene: '通勤' });
  assert.equal(copy.copies.length, 2);
  assert.ok(copy.copies.every(x => x.content.length <= 80));
  const title = normalizeResult('a7', fallback('a7', '通勤双肩包', { count: 3, maxLength: 12, keywords: '双肩包\n通勤', sellingPoints: '轻量' }), { count: 3, maxLength: 12, keywords: '双肩包\n通勤' });
  assert.equal(title.titles.length, 3);
  assert.ok(title.titles.every(x => Array.isArray(x.checks)));
  assert.equal(copy.data_source, 'template');
});
