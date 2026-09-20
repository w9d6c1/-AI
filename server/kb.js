// ===== 知识库 RAG（无嵌入的轻量检索）=====
// 分块存储 + 关键词打分（中文 2-gram / 英文单词）。避免引入嵌入模型依赖。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');

const CHUNK_SIZE = Number(process.env.KB_CHUNK_SIZE || 500);
const CHUNK_OVERLAP = Number(process.env.KB_CHUNK_OVERLAP || 80);

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  const chunks = [];
  let i = 0;
  while (i < s.length) {
    const end = Math.min(s.length, i + size);
    chunks.push(s.slice(i, end));
    if (end >= s.length) break;
    i = end - overlap;
  }
  return chunks;
}

// 中文 2-gram + 英文/数字单词
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const terms = new Set();
  for (const t of (s.match(/[a-z0-9]{2,}/g) || [])) terms.add(t);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

function scoreChunk(content, terms) {
  const text = String(content || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let idx = text.indexOf(term);
    while (idx !== -1) { score += 1; idx = text.indexOf(term, idx + term.length); }
  }
  return score / Math.sqrt(text.length + 1);
}

// 建立/重建某文档的分块索引
async function indexDoc({ userId, docId, content }) {
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM kb_chunks WHERE doc_id=? AND tenant_id=?', [docId, t]);
  const chunks = chunkText(content);
  for (let i = 0; i < chunks.length; i++) {
    await repos.adapter.run(
      'INSERT INTO kb_chunks (tenant_id, user_id, doc_id, chunk_index, content, tokens) VALUES (?,?,?,?,?,?)',
      [t, userId, docId, i, chunks[i], Math.ceil(chunks[i].length / 2)]
    );
  }
  return chunks.length;
}

// 检索：返回按相关度排序的分块
async function search({ userId, query, topK = 5 }) {
  const t = requireTenant();
  const terms = tokenize(query);
  if (!terms.length) return [];
  const rows = await repos.adapter.all(
    'SELECT id, doc_id, chunk_index, content FROM kb_chunks WHERE tenant_id=? AND user_id=?',
    [t, userId]
  );
  return rows
    .map(r => ({ ...r, score: Math.round(scoreChunk(r.content, terms) * 10000) / 10000 }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function chunkCount(docId) {
  const t = requireTenant();
  const row = await repos.adapter.get('SELECT COUNT(*) c FROM kb_chunks WHERE doc_id=? AND tenant_id=?', [docId, t]);
  return Number((row && row.c) || 0);
}

module.exports = { chunkText, tokenize, scoreChunk, indexDoc, search, chunkCount, CHUNK_SIZE, CHUNK_OVERLAP };
