// ===== 画板 / 竞品 / 任务 / 课程 / 图片 / 知识库 路由 =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { nowExpr } = require('../repositories/sql');
const { enforceAiQuota } = require('../quota');
const { authRequired, asyncH } = require('../middleware');
const { imageGen, sizeForRatio, localUploadToDataUri } = require('../ai');
const { ownedFile, registerFile, signFile } = require('../files');
const kb = require('../kb');
const { runAgent } = require('../inference');

const router = express.Router();
router.use(authRequired);

// ---------- 无限画板 ----------
async function ensureBoard(userId) {
  const t = requireTenant();
  let board = await repos.adapter.get('SELECT * FROM canvas_boards WHERE user_id=? AND tenant_id=? ORDER BY updated_at DESC LIMIT 1', [userId, t]);
  if (!board) {
    const info = await repos.adapter.run('INSERT INTO canvas_boards (tenant_id, user_id, name) VALUES (?,?,?)', [t, userId, '我的画板']);
    board = await repos.adapter.get('SELECT * FROM canvas_boards WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]);
  }
  return board;
}

router.get('/canvas', asyncH(async (req, res) => {
  const t = requireTenant();
  const board = await ensureBoard(req.user.id);
  const elements = await repos.adapter.all('SELECT id, type, x, y, text, color FROM canvas_elements WHERE board_id=? AND tenant_id=?', [board.id, t]);
  res.json({ board, elements });
}));

router.post('/canvas/elements', asyncH(async (req, res) => {
  const t = requireTenant();
  const { type, x, y, text, color } = req.body || {};
  const board = await ensureBoard(req.user.id);
  const info = await repos.adapter.run(
    'INSERT INTO canvas_elements (tenant_id, board_id, type, x, y, text, color) VALUES (?,?,?,?,?,?,?)',
    [t, board.id, type || 'node', x || 100, y || 100, text || '新节点', color || '#0d9488']
  );
  await repos.adapter.run(`UPDATE canvas_boards SET updated_at=${nowExpr(repos.adapter.dialect)} WHERE id=? AND tenant_id=?`, [board.id, t]);
  res.json({ element: await repos.adapter.get('SELECT id, type, x, y, text, color FROM canvas_elements WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.put('/canvas/elements/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const { x, y, text, color } = req.body || {};
  const el = await repos.adapter.get('SELECT ce.* FROM canvas_elements ce JOIN canvas_boards cb ON ce.board_id=cb.id AND cb.tenant_id=ce.tenant_id WHERE ce.id=? AND cb.user_id=? AND ce.tenant_id=?', [req.params.id, req.user.id, t]);
  if (!el) return res.status(404).json({ error: '元素不存在' });
  await repos.adapter.run('UPDATE canvas_elements SET x=?, y=?, text=?, color=? WHERE id=? AND tenant_id=?',
    [x ?? el.x, y ?? el.y, text ?? el.text, color ?? el.color, req.params.id, t]);
  res.json({ ok: true });
}));

router.delete('/canvas/elements/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const info = await repos.adapter.run(
    'DELETE FROM canvas_elements WHERE id=? AND tenant_id=? AND board_id IN (SELECT id FROM canvas_boards WHERE user_id=? AND tenant_id=?)',
    [req.params.id, t, req.user.id, t]
  );
  res.json({ ok: Number(info.changes) > 0 });
}));

// ---------- 竞品分析 ----------
router.get('/competitor', asyncH(async (req, res) => {
  const t = requireTenant();
  const reports = await repos.adapter.all('SELECT id, target, created_at FROM competitor_reports WHERE user_id=? AND tenant_id=? ORDER BY id DESC', [req.user.id, t]);
  res.json({ reports });
}));

router.post('/competitor', asyncH(async (req, res) => {
  const t = requireTenant();
  const { target } = req.body || {};
  if (!target || !String(target).trim()) return res.status(400).json({ error: '请输入竞品链接或关键词' });
  const name = String(target).trim();
  await enforceAiQuota();
  // 真实化：由竞品分析智能体（LLM，可降级框架）生成，不再返回硬编码假数据
  const result = await runAgent('a19', name, { userId: req.user.id });
  const report = result.result || {};
  report.data_source = report.data_source || (result.source === 'llm' ? 'llm' : 'framework');
  const info = await repos.adapter.run('INSERT INTO competitor_reports (tenant_id, user_id, target, report) VALUES (?,?,?,?)', [t, req.user.id, name, JSON.stringify(report)]);
  res.json({ id: info.lastInsertRowid, report, source: result.source });
}));

// ---------- 自动化任务 ----------
router.get('/tasks', asyncH(async (req, res) => {
  const t = requireTenant();
  const tasks = await repos.adapter.all('SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY id', [req.user.id, t]);
  res.json({ tasks });
}));

router.post('/tasks', asyncH(async (req, res) => {
  const t = requireTenant();
  const { name, icon, color, desc, freq } = req.body || {};
  if (!name) return res.status(400).json({ error: '任务名称不能为空' });
  const info = await repos.adapter.run(
    'INSERT INTO tasks (tenant_id, user_id, name, icon, color, "desc", freq) VALUES (?,?,?,?,?,?,?)',
    [t, req.user.id, String(name), icon || '📊', color || '#f0fdfa', desc || '', freq || '每日 09:00']
  );
  res.json({ task: await repos.adapter.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.patch('/tasks/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const { enabled, name, freq } = req.body || {};
  const task = await repos.adapter.get('SELECT * FROM tasks WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  await repos.adapter.run('UPDATE tasks SET enabled=?, name=?, freq=? WHERE id=? AND tenant_id=?',
    [enabled === undefined ? task.enabled : (enabled ? 1 : 0), name ?? task.name, freq ?? task.freq, req.params.id, t]);
  const updated = await repos.adapter.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await repos.adapter.run('INSERT INTO task_logs (tenant_id, task_id, user_id, msg, status) VALUES (?,?,?,?,?)',
    [t, task.id, req.user.id, `任务「${updated.name}」已${updated.enabled ? '启用' : '暂停'}`, 'info']);
  res.json({ task: updated });
}));

router.post('/tasks/:id/run', asyncH(async (req, res) => {
  const t = requireTenant();
  const task = await repos.adapter.get('SELECT * FROM tasks WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const now = new Date().toLocaleString('zh-CN');
  await repos.adapter.run('UPDATE tasks SET last_run_at=? WHERE id=? AND tenant_id=?', [now, task.id, t]);
  await repos.adapter.run('INSERT INTO task_logs (tenant_id, task_id, user_id, msg, status) VALUES (?,?,?,?,?)',
    [t, task.id, req.user.id, `✓ 任务「${task.name}」执行完成（${now}）`, 'success']);
  res.json({ ok: true, ranAt: now });
}));

router.get('/task-logs', asyncH(async (req, res) => {
  const t = requireTenant();
  const logs = await repos.adapter.all('SELECT * FROM task_logs WHERE user_id=? AND tenant_id=? ORDER BY id DESC LIMIT 50', [req.user.id, t]);
  res.json({ logs });
}));

// ---------- 学习中心 ----------
router.get('/courses', asyncH(async (req, res) => {
  const t = requireTenant();
  const courses = await repos.adapter.all('SELECT * FROM courses ORDER BY id');
  const progress = await repos.adapter.all('SELECT course_id, progress FROM course_progress WHERE user_id=? AND tenant_id=?', [req.user.id, t]);
  const pMap = {};
  progress.forEach(p => { pMap[p.course_id] = p.progress; });
  res.json({ courses: courses.map(c => ({ ...c, progress: pMap[c.id] || 0 })) });
}));

router.put('/courses/:id/progress', asyncH(async (req, res) => {
  const t = requireTenant();
  const { progress } = req.body || {};
  const course = await repos.adapter.get('SELECT * FROM courses WHERE id=?', [req.params.id]);
  if (!course) return res.status(404).json({ error: '课程不存在' });
  const p = Math.max(0, Math.min(100, Number(progress) || 0));
  const now = nowExpr(repos.adapter.dialect);
  await repos.adapter.run(
    `INSERT INTO course_progress (tenant_id, user_id, course_id, progress, chapters_done, updated_at) VALUES (?,?,?,?,?,${now})
     ON CONFLICT(user_id, course_id) DO UPDATE SET progress=excluded.progress, updated_at=${now}`,
    [t, req.user.id, course.id, p, 0]
  );
  res.json({ ok: true, progress: p });
}));

// ---------- AI 图片生成 ----------
router.post('/images/generate', asyncH(async (req, res) => {
  const t = requireTenant();
  const { prompt, style, ratio, count, mode, ref_image } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: '请输入画面描述' });
  const n = Math.min(6, Math.max(1, Number(count) || 4));
  const size = sizeForRatio(ratio);

  let refImage = null;
  if ((mode === 'img2img' || mode === 'scene') && ref_image) {
    refImage = localUploadToDataUri(await ownedFile(req.user, ref_image));
    if (!refImage) return res.status(400).json({ error: '参考图不存在或格式不支持' });
  }

  await enforceAiQuota();
  const fullPrompt = style ? `（风格：${style}）${prompt}` : prompt;
  const result = await imageGen(fullPrompt, { n, size, image: refImage });
  const urls = result.urls || [];
  const info = await repos.adapter.run('INSERT INTO images (tenant_id, user_id, prompt, style, ratio, url) VALUES (?,?,?,?,?,?)',
    [t, req.user.id, String(prompt).slice(0, 500), style || '', ratio || '1:1', urls[0] || '']);
  const signed = await Promise.all(urls.map(url => registerFile(req.user, url)));
  res.json({ prompt, count: urls.length, urls: signed, source: result.source, recordId: info.lastInsertRowid });
}));

router.get('/images', asyncH(async (req, res) => {
  const t = requireTenant();
  const images = await repos.adapter.all('SELECT id, prompt, style, ratio, url, created_at FROM images WHERE user_id=? AND tenant_id=? ORDER BY id DESC LIMIT 50', [req.user.id, t]);
  const signed = await Promise.all(images.map(async img => ({ ...img, url: await signFile(req.user, img.url) })));
  res.json({ images: signed });
}));

// ---------- 知识库 ----------
router.get('/kb-docs', asyncH(async (req, res) => {
  const t = requireTenant();
  const docs = await repos.adapter.all('SELECT id, name, size, status, created_at FROM kb_docs WHERE user_id=? AND tenant_id=? ORDER BY id DESC', [req.user.id, t]);
  res.json({ docs });
}));

router.post('/kb-docs', asyncH(async (req, res) => {
  const t = requireTenant();
  const { name, size, content } = req.body || {};
  if (!name) return res.status(400).json({ error: '文档名称不能为空' });
  const text = typeof content === 'string' ? content : '';
  const info = await repos.adapter.run('INSERT INTO kb_docs (tenant_id, user_id, name, size, status) VALUES (?,?,?,?,?)',
    [t, req.user.id, String(name), Number(size) || text.length || 0, text ? 'indexing' : 'pending']);
  const docId = info.lastInsertRowid;
  let chunks = 0;
  if (text) {
    chunks = await kb.indexDoc({ userId: req.user.id, docId, content: text });
    await repos.adapter.run('UPDATE kb_docs SET status=? WHERE id=? AND tenant_id=?', ['indexed', docId, t]);
  }
  res.json({ doc: await repos.adapter.get('SELECT id, name, size, status, created_at FROM kb_docs WHERE id=? AND tenant_id=?', [docId, t]), chunks });
}));

router.get('/kb-docs/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const doc = await repos.adapter.get('SELECT id, name, size, status, created_at FROM kb_docs WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  const chunks = await kb.chunkCount(doc.id);
  const preview = (await repos.adapter.all('SELECT chunk_index, content FROM kb_chunks WHERE doc_id=? AND user_id=? AND tenant_id=? ORDER BY chunk_index LIMIT 3', [doc.id, req.user.id, t]));
  res.json({ doc, chunk_count: chunks, preview });
}));

// 写入/重建文档内容并索引
router.post('/kb-docs/:id/content', asyncH(async (req, res) => {
  const t = requireTenant();
  const doc = await repos.adapter.get('SELECT * FROM kb_docs WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  const content = typeof (req.body || {}).content === 'string' ? req.body.content : '';
  if (!content.trim()) return res.status(400).json({ error: '内容不能为空' });
  const chunks = await kb.indexDoc({ userId: req.user.id, docId: doc.id, content });
  await repos.adapter.run('UPDATE kb_docs SET status=?, size=? WHERE id=? AND tenant_id=?', ['indexed', content.length, doc.id, t]);
  res.json({ ok: true, chunks });
}));

// 知识库检索（RAG）
router.post('/kb-search', asyncH(async (req, res) => {
  const { query, top_k } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: '请输入检索内容' });
  const topK = Math.min(20, Math.max(1, Number(top_k) || 5));
  const results = await kb.search({ userId: req.user.id, query: String(query), topK });
  res.json({ query: String(query), results });
}));

router.delete('/kb-docs/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM kb_chunks WHERE doc_id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  await repos.adapter.run('DELETE FROM kb_docs WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  res.json({ ok: true });
}));

module.exports = router;
