// ===== 对话路由 =====
const express = require('express');
const { repos } = require('../repositories');
const { nowExpr } = require('../repositories/sql');
const { requireTenant } = require('../repositories/tenant-context');
const { enforceAiQuota, enforceCostQuota } = require('../quota');
const { authRequired, asyncH } = require('../middleware');
const { chatReply } = require('../ai');
const kb = require('../kb');

const router = express.Router();
router.use(authRequired);

router.get('/chats', asyncH(async (req, res) => {
  const t = requireTenant();
  const chats = await repos.adapter.all(
    'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.tenant_id=c.tenant_id) AS msg_count FROM chats c WHERE c.user_id=? AND c.tenant_id=? ORDER BY c.updated_at DESC',
    [req.user.id, t]
  );
  res.json({ chats });
}));

router.post('/chats', asyncH(async (req, res) => {
  const t = requireTenant();
  const { title } = req.body || {};
  const info = await repos.adapter.run('INSERT INTO chats (user_id, title, tenant_id) VALUES (?,?,?)', [req.user.id, title || '新对话', t]);
  const chat = await repos.adapter.get('SELECT * FROM chats WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]);
  res.json({ chat });
}));

router.get('/chats/:id/messages', asyncH(async (req, res) => {
  const t = requireTenant();
  const chat = await repos.adapter.get('SELECT * FROM chats WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!chat) return res.status(404).json({ error: '对话不存在' });
  const messages = await repos.adapter.all('SELECT id, role, content, created_at FROM messages WHERE chat_id=? AND tenant_id=? ORDER BY id', [req.params.id, t]);
  res.json({ chat, messages });
}));

router.post('/chats/:id/messages', asyncH(async (req, res) => {
  const t = requireTenant();
  const { content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '消息内容不能为空' });
  const chat = await repos.adapter.get('SELECT * FROM chats WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!chat) return res.status(404).json({ error: '对话不存在' });

  const text = String(content).trim();
  await repos.tx(async () => {
    await repos.adapter.run('INSERT INTO messages (chat_id, role, content, tenant_id) VALUES (?,?,?,?)', [req.params.id, 'user', text, t]);
    await repos.adapter.run(
      `UPDATE chats SET updated_at=${nowExpr(repos.adapter.dialect)}, title=CASE WHEN title='新对话' THEN ? ELSE title END WHERE id=? AND tenant_id=?`,
      [text.slice(0, 20), req.params.id, t]
    );
  });

  const history = (await repos.adapter.all('SELECT role, content FROM messages WHERE chat_id=? AND tenant_id=? ORDER BY id DESC LIMIT 8', [req.params.id, t])).reverse();

  await enforceAiQuota();
  await enforceCostQuota();
  // RAG：按用户问题检索其知识库，注入对话上下文
  const chunks = await kb.search({ userId: req.user.id, query: text, topK: 4 });
  const knowledge = chunks.length ? chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n') : '';
  const result = await chatReply(text, history.map(m => ({ role: m.role, content: m.content })), { knowledge });
  await repos.adapter.run('INSERT INTO messages (chat_id, role, content, tenant_id) VALUES (?,?,?,?)', [req.params.id, 'ai', result.content, t]);

  const messages = await repos.adapter.all('SELECT id, role, content, created_at FROM messages WHERE chat_id=? AND tenant_id=? ORDER BY id', [req.params.id, t]);
  res.json({ messages, aiSource: result.source, kb_used: chunks.length });
}));

router.delete('/chats/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const info = await repos.adapter.run('DELETE FROM chats WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (Number(info.changes) === 0) return res.status(404).json({ error: '对话不存在' });
  res.json({ ok: true });
}));

module.exports = router;
