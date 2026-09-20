// ===== 阶段 8 · 安全中心视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 安全中心 ----------
async function loadSecurity() {
  const box = $('security-2fa');
  const status = $('security-status');
  if (!box) return;
  try {
    const s = await API.get('/auth/security');
    status.innerHTML = `密码最近修改：${esc(s.password_changed_at || '未知')} ｜ 密码策略：至少 ${s.password_policy.min_length} 位 ｜ 恢复码剩余：${s.recovery_codes_remaining}`;
    if (s.totp_enabled) {
      box.innerHTML = `<div style="color:#10b981;margin-bottom:10px;">已启用两步验证</div>
        <div style="display:flex;gap:8px;"><input id="2fa-disable-code" placeholder="验证码或恢复码" style="padding:8px;border:1px solid var(--border);border-radius:6px;flex:1;">
        <button class="btn btn-outline btn-sm" onclick="disable2FA()">关闭 2FA</button></div>`;
    } else {
      box.innerHTML = `<div style="color:var(--text-muted);margin-bottom:10px;">未启用。启用后登录需输入动态验证码。</div>
        <button class="btn btn-primary btn-sm" onclick="start2FASetup()">启用两步验证</button>
        <div id="2fa-setup-box" style="margin-top:12px;"></div>`;
    }
  } catch (e) { box.innerHTML = `<span style="color:#dc2626;">${esc(e.message)}</span>`; }
}
async function start2FASetup() {
  try {
    const data = await API.post('/auth/2fa/setup');
    $('2fa-setup-box').innerHTML = `
      <div style="background:var(--bg);padding:12px;border-radius:8px;">
        <div>密钥（手动录入验证器）：<code style="user-select:all;">${esc(data.secret)}</code></div>
        <div style="margin-top:6px;word-break:break-all;font-size:11px;color:var(--text-muted);">${esc(data.otpauth_url)}</div>
        <div style="margin-top:8px;">恢复码（请妥善保存，仅显示一次）：</div>
        <div style="font-family:monospace;margin-top:4px;">${data.recovery_codes.map(esc).join('　')}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;"><input id="2fa-verify-code" placeholder="输入验证器动态码" style="padding:8px;border:1px solid var(--border);border-radius:6px;flex:1;">
      <button class="btn btn-primary btn-sm" onclick="verify2FA()">确认启用</button></div>`;
  } catch (e) { showToast(e.message, 'error'); }
}
async function verify2FA() {
  try {
    await API.post('/auth/2fa/verify', { code: $('2fa-verify-code').value.trim() });
    showToast('两步验证已启用', 'success');
    loadSecurity();
  } catch (e) { showToast(e.message, 'error'); }
}
async function disable2FA() {
  const code = $('2fa-disable-code').value.trim();
  const password = prompt('请输入当前密码以关闭两步验证');
  if (!password) return;
  try {
    await API.post('/auth/2fa/disable', { password, code });
    showToast('两步验证已关闭', 'success');
    loadSecurity();
  } catch (e) { showToast(e.message, 'error'); }
}
async function changePassword() {
  const current = $('pwd-current').value;
  const next = $('pwd-new').value;
  if (!current || !next) { showToast('请填写当前密码与新密码', 'warn'); return; }
  try {
    const data = await API.post('/auth/password', { current_password: current, new_password: next });
    if (data.token) localStorage.setItem('zy_token', data.token);
    $('pwd-current').value = ''; $('pwd-new').value = '';
    showToast('密码已修改', 'success');
    loadSecurity();
  } catch (e) { showToast(e.message, 'error'); }
}
