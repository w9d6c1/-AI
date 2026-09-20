const path = require('path');
const jwt = require('jsonwebtoken');
const { repos } = require('./repositories');
const { httpError } = require('./access');
const { requireTenant, runWithTenant } = require('./repositories/tenant-context');
const storage = require('./integrations/storage');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

function canonicalUrl(value) {
  if (typeof value !== 'string') throw httpError(400, '无效文件地址');
  const url = value.split('?')[0];
  if (!/^\/uploads\/(?:generated\/)?[a-zA-Z0-9_.-]+$/.test(url) || url.includes('..')) throw httpError(400, '无效文件地址');
  return url;
}

async function ownedFile(user, value) {
  const url = canonicalUrl(value);
  const t = requireTenant();
  const row = await repos.adapter.get('SELECT 1 AS ok FROM file_assets WHERE url=? AND user_id=? AND tenant_id=?', [url, user.id, t]);
  if (!row) throw httpError(403, '无权使用该文件，请重新上传');
  return url;
}

async function signFile(user, value) {
  if (!value?.startsWith('/uploads/')) return value;
  const url = await ownedFile(user, value);
  const t = requireTenant();
  const version = await repos.users.getSessionVersion(user.id, { tenantId: t });
  const token = jwt.sign({ purpose: 'file', url, uid: user.id, version, tenantId: t }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return url + '?access=' + encodeURIComponent(token);
}

async function registerFile(user, url) {
  if (!url.startsWith('/uploads/')) return url;
  const canonical = canonicalUrl(url);
  const t = requireTenant();
  const existing = await repos.adapter.get('SELECT 1 AS ok FROM file_assets WHERE url=? AND tenant_id=?', [canonical, t]);
  if (!existing) {
    await repos.adapter.run('INSERT INTO file_assets (tenant_id,url,user_id) VALUES (?,?,?)', [t, canonical, user.id]);
  }
  return signFile(user, url);
}

async function fileAccess(req, res, next) {
  try {
    const url = canonicalUrl('/uploads' + req.path);
    const payload = jwt.verify(req.query.access || '', process.env.JWT_SECRET);
    const tenantId = payload.tenantId ?? 1;
    await runWithTenant(tenantId, async () => {
      const version = await repos.users.getSessionVersion(payload.uid, { tenantId });
      const ok = payload.purpose === 'file' && payload.url === url && version !== null &&
        Number(version) === Number(payload.version) &&
        !!(await repos.adapter.get('SELECT 1 AS ok FROM file_assets WHERE url=? AND user_id=? AND tenant_id=?', [url, payload.uid, tenantId]));
      if (!ok) throw new Error('invalid file token');
    });
    res.setHeader('Cache-Control', 'private, no-store');
    // 对象存储驱动：校验归属后 302 到预签名 URL
    if (!storage.isLocal()) {
      const key = url.replace(/^\/uploads\//, '');
      const signed = await storage.getSignedUrl(key, 3600);
      return res.redirect(302, signed);
    }
    next();
  } catch { res.status(403).json({ error: '文件链接无效或已过期，请刷新页面' }); }
}

module.exports = { UPLOAD_DIR, ownedFile, signFile, registerFile, fileAccess };
