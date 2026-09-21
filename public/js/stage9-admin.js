// ===== 阶段 9 · 超管运营后台（平台总览 + 租户运营）=====
// 仅 superadmin 可见（导航 data-superadmin + SUPERADMIN_ROUTES 守卫）。作为全局脚本，加载顺序须早于主脚本。

const TENANT_PLANS = ['trial', 'basic', 'pro', 'enterprise', 'internal'];

// ---------- 平台总览 ----------
async function initAdminOverview() { loadAdminOverview(); }

async function loadAdminOverview() {
  const box = $('admin-overview-metrics');
  if (!box) return;
  box.innerHTML = '<div class="metric-card"><div class="metric-label">加载中…</div><div class="metric-value">—</div></div>';
  try {
    const d = await API.get('/admin/overview');
    const cards = [
      { label: '租户总数', value: d.tenants.total, sub: `活跃 ${d.tenants.active} / 停用 ${d.tenants.suspended}`, color: 'm-primary' },
      { label: '店铺总数', value: d.shops, sub: '全部租户', color: 'm-info' },
      { label: '用户总数', value: d.users, sub: '全部租户', color: 'm-accent' },
      { label: `本月 AI 成本（${d.month}）`, value: '¥' + Number(d.ai.cost).toLocaleString('zh-CN'), sub: `调用 ${d.ai.calls} 次`, color: 'm-success' },
      { label: 'MRR 估算', value: '¥' + Number(d.mrr).toLocaleString('zh-CN'), sub: '活跃租户月费合计', color: 'm-primary' }
    ];
    box.innerHTML = cards.map(c => `<div class="metric-card ${c.color}">
      <div class="metric-label">${esc(c.label)}</div>
      <div class="metric-value">${esc(String(c.value))}</div>
      <div class="metric-change">${esc(c.sub)}</div>
    </div>`).join('');
    $('admin-overview-tenants').textContent = `共 ${d.tenants.total} 个租户：活跃 ${d.tenants.active}，停用 ${d.tenants.suspended}；店铺 ${d.shops} 个，用户 ${d.users} 个。`;
  } catch (e) {
    box.innerHTML = `<div style="color:#dc2626;">${esc(e.message)}</div>`;
  }
}

// ---------- 租户运营 ----------
async function initAdminTenants() { loadAdminTenants(); }

async function loadAdminTenants() {
  const tb = $('admin-tenants-tbody');
  if (!tb) return;
  tb.innerHTML = emptyState('加载中…', 12);
  try {
    const data = await API.get('/admin/tenants');
    const list = data.tenants || [];
    if (!list.length) { tb.innerHTML = emptyState('暂无租户', 12); return; }
    tb.innerHTML = list.map(t => {
      const statusTag = t.status === 'active' ? '<span class="tag tag-success">活跃</span>' : '<span class="tag tag-danger">停用</span>';
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px;">${t.id}</td>
        <td style="padding:8px;">${esc(t.name)}</td>
        <td style="padding:8px;">${esc(t.slug || '—')}</td>
        <td style="padding:8px;">${statusTag}</td>
        <td style="padding:8px;">${esc(t.plan || '—')}</td>
        <td style="padding:8px;">${t.max_shops ?? '—'}</td>
        <td style="padding:8px;">${fmtNum(t.max_ai_calls_per_month)}</td>
        <td style="padding:8px;">${t.max_tokens_per_month ? fmtNum(t.max_tokens_per_month) : '不限'}</td>
        <td style="padding:8px;">${t.max_cost_per_month ? '¥' + t.max_cost_per_month : '不限'}</td>
        <td style="padding:8px;">¥${Number(t.price_per_month || 0).toLocaleString('zh-CN')}</td>
        <td style="padding:8px;font-size:12px;">${esc(t.trial_ends_at || '—')}</td>
        <td style="padding:8px;white-space:nowrap;">
          <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="showTenantForm(${t.id})">编辑</button>
          <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="showTenantUsage(${t.id})">用量</button>
          <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="showTenantUsers(${t.id})">用户</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 12); }
}

async function showTenantForm(id) {
  let t = null;
  if (id) {
    try {
      const data = await API.get('/admin/tenants');
      t = (data.tenants || []).find(x => x.id === id);
    } catch (e) { showToast(e.message, 'error'); return; }
    if (!t) { showToast('租户不存在', 'error'); return; }
  }
  const inp = 'width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;';
  const trialVal = t && t.trial_ends_at ? esc(String(t.trial_ends_at).slice(0, 10)) : '';
  openGenericModal(id ? ('编辑租户 #' + id) : '新建租户', `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div><label style="font-size:12px;">名称</label><input id="ten-name" value="${t ? esc(t.name) : ''}" style="${inp}"></div>
      <div><label style="font-size:12px;">slug</label><input id="ten-slug" value="${t ? esc(t.slug || '') : ''}" style="${inp}"></div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">套餐</label>
          <select id="ten-plan" style="${inp}">${TENANT_PLANS.map(p => `<option value="${p}"${t && t.plan === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
        <div style="flex:1;"><label style="font-size:12px;">状态</label>
          <select id="ten-status" style="${inp}">
            <option value="active"${!t || t.status === 'active' ? ' selected' : ''}>活跃</option>
            <option value="suspended"${t && t.status === 'suspended' ? ' selected' : ''}>停用</option>
          </select></div>
      </div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">店铺上限</label><input id="ten-max-shops" type="number" value="${t ? (t.max_shops ?? '') : 50}" style="${inp}"></div>
        <div style="flex:1;"><label style="font-size:12px;">AI 调用上限/月</label><input id="ten-max-calls" type="number" value="${t ? (t.max_ai_calls_per_month ?? '') : 100000}" style="${inp}"></div>
      </div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">成本上限/月（0=不限）</label><input id="ten-max-cost" type="number" step="0.01" value="${t ? (t.max_cost_per_month ?? 0) : 0}" style="${inp}"></div>
        <div style="flex:1;"><label style="font-size:12px;">token 上限/月（0=不限）</label><input id="ten-max-tokens" type="number" value="${t ? (t.max_tokens_per_month ?? 0) : 0}" style="${inp}"></div>
      </div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">月费（¥）</label><input id="ten-price" type="number" step="0.01" value="${t ? (t.price_per_month ?? 0) : 0}" style="${inp}"></div>
        <div style="flex:1;"><label style="font-size:12px;">计费周期</label>
          <select id="ten-cycle" style="${inp}">
            <option value="monthly"${!t || t.billing_cycle === 'monthly' ? ' selected' : ''}>月付</option>
            <option value="yearly"${t && t.billing_cycle === 'yearly' ? ' selected' : ''}>年付</option>
          </select></div>
      </div>
      <div><label style="font-size:12px;">试用到期</label><input id="ten-trial" type="date" value="${trialVal}" style="${inp}"></div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">联系人</label><input id="ten-contact" value="${t ? esc(t.contact_name || '') : ''}" style="${inp}"></div>
        <div style="flex:1;"><label style="font-size:12px;">联系邮箱</label><input id="ten-email" value="${t ? esc(t.contact_email || '') : ''}" style="${inp}"></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="submitTenantForm(${id || 0})">${id ? '保存' : '创建'}</button>
    </div>`);
}

async function submitTenantForm(id) {
  const body = {
    name: ($('ten-name').value || '').trim(),
    slug: ($('ten-slug').value || '').trim() || undefined,
    plan: $('ten-plan').value,
    max_shops: Number($('ten-max-shops').value) || 0,
    max_ai_calls_per_month: Number($('ten-max-calls').value) || 0,
    max_tokens_per_month: Number($('ten-max-tokens').value) || 0,
    max_cost_per_month: Number($('ten-max-cost').value) || 0,
    price_per_month: Number($('ten-price').value) || 0,
    billing_cycle: $('ten-cycle').value,
    trial_ends_at: $('ten-trial').value || null,
    contact_name: ($('ten-contact').value || '').trim() || null,
    contact_email: ($('ten-email').value || '').trim() || null
  };
  if (id) body.status = $('ten-status').value;
  if (!body.name) { showToast('请输入租户名称', 'warn'); return; }
  try {
    if (id) await API.patch('/admin/tenants/' + id, body);
    else await API.post('/admin/tenants', body);
    showToast(id ? '已保存' : '租户已创建', 'success');
    closeModal('modal-generic');
    loadAdminTenants();
  } catch (e) { showToast(e.message, 'error'); }
}

async function showTenantUsage(id) {
  try {
    const d = await API.get('/admin/tenants/' + id + '/usage');
    const u = d.usage || { ai: {}, agent_runs: {} };
    const l = d.limits || {};
    const used = d.used || {};
    const bar = (label, usedV, maxV, unit) => {
      const pct = maxV ? Math.min(100, Math.round((Number(usedV) / maxV) * 100)) : null;
      return `<div style="margin-bottom:10px;">
        <div style="font-size:12px;">${esc(label)}：${fmtNum(usedV)}${unit}${maxV ? ' / ' + fmtNum(maxV) + unit : '（不限）'}</div>
        ${pct !== null ? `<div style="height:6px;background:var(--border);border-radius:3px;margin-top:4px;"><div style="height:6px;width:${pct}%;background:${pct >= 90 ? '#ef4444' : '#0d9488'};border-radius:3px;"></div></div>` : ''}
      </div>`;
    };
    const alerts = d.alerts || [];
    const alertsHtml = alerts.length ? `<div style="margin:10px 0;padding:8px 10px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;font-size:12px;color:#9a3412;">
      <b>配额告警</b><ul style="margin:4px 0 0 18px;">${alerts.map(a => `<li>${esc(a.label)} 已用 ${a.pct}%${a.level === 'exceeded' ? '（已超限）' : '（预警）'}</li>`).join('')}</ul></div>` : '';
    openGenericModal('租户用量 #' + id + '（' + esc(d.month) + '）', `
      ${bar('店铺', used.shops, l.max_shops, '')}
      ${bar('AI 调用', used.ai_calls, l.max_ai_calls_per_month, ' 次')}
      ${bar('AI tokens', used.ai_tokens, l.max_tokens_per_month, '')}
      ${bar('AI 成本', used.ai_cost, l.max_cost_per_month, ' 元')}
      ${alertsHtml}
      <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">
        本月 tokens：入 ${fmtNum(u.ai.tokens_in)} / 出 ${fmtNum(u.ai.tokens_out)} ｜ 智能体运行 ${fmtNum(u.agent_runs.runs)} 次
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">
        计费：${esc(d.billing.cycle || 'monthly')} ｜ 月费 ¥${d.billing.price_per_month} ｜ 试用到期 ${esc(d.billing.trial_ends_at || '—')}
      </div>`);
  } catch (e) { showToast(e.message, 'error'); }
}

async function showTenantUsers(id) {
  try {
    const data = await API.get('/admin/tenants/' + id + '/users');
    const users = data.users || [];
    openGenericModal('租户 #' + id + ' 用户', users.length
      ? `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="border-bottom:2px solid var(--border);text-align:left;">
            <th style="padding:6px;">ID</th><th style="padding:6px;">用户名</th><th style="padding:6px;">角色</th>
            <th style="padding:6px;">创建时间</th><th style="padding:6px;">操作</th>
          </tr></thead>
          <tbody>${users.map(u => `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:6px;">${u.id}</td>
            <td style="padding:6px;">${esc(u.username)}</td>
            <td style="padding:6px;">${esc(u.role)}</td>
            <td style="padding:6px;">${esc(u.created_at || '')}</td>
            <td style="padding:6px;"><button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="impersonateUser(${u.id})">代登录</button></td>
          </tr>`).join('')}</tbody>
        </table></div>`
      : '<div style="color:var(--text-muted);">该租户暂无用户</div>');
  } catch (e) { showToast(e.message, 'error'); }
}

function impersonateUser(userId) {
  customConfirm('将以该用户身份进入（只读，15 分钟）。超管会话会暂存，可随时「退出代登录」恢复。确认？', '代登录', async () => {
    try {
      const d = await API.post('/admin/users/' + userId + '/impersonate');
      const prevToken = localStorage.getItem('zy_token');
      const prevUser = localStorage.getItem('zy_user');
      if (prevToken && prevUser && !localStorage.getItem('zy_super_session')) {
        try {
          const u = JSON.parse(prevUser);
          if (u && u.role === 'superadmin') localStorage.setItem('zy_super_session', JSON.stringify({ token: prevToken, user: prevUser }));
        } catch (_) { /* ignore */ }
      }
      localStorage.setItem('zy_token', d.token);
      localStorage.setItem('zy_user', JSON.stringify({ id: d.user.id, username: d.user.username, role: 'member' }));
      showToast('已进入代登录（只读）', 'success');
      setTimeout(() => location.reload(), 600);
    } catch (e) { showToast(e.message, 'error'); }
  }, { icon: '👤' });
}

function exitImpersonation() {
  const saved = localStorage.getItem('zy_super_session');
  if (!saved) { showToast('未处于代登录状态', 'warn'); return; }
  try {
    const { token, user } = JSON.parse(saved);
    localStorage.setItem('zy_token', token);
    localStorage.setItem('zy_user', user);
    localStorage.removeItem('zy_super_session');
    showToast('已退出代登录，恢复超管会话', 'success');
    setTimeout(() => location.reload(), 400);
  } catch (e) { showToast('恢复会话失败：' + e.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const banner = $('impersonate-banner');
  if (banner && localStorage.getItem('zy_super_session')) banner.style.display = 'flex';
});
