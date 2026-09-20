// ===== 上传病毒扫描（ClamAV clamd INSTREAM，可配置 fail-closed）=====
// SCAN_UPLOADS=true 时启用；未配置 CLAMAV_HOST 时按 SCAN_FAIL_CLOSED 决定放行或拒绝。
const net = require('net');

function enabled() { return process.env.SCAN_UPLOADS === 'true'; }
function config() {
  return {
    host: process.env.CLAMAV_HOST || '',
    port: Number(process.env.CLAMAV_PORT || 3310),
    timeout: Number(process.env.CLAMAV_TIMEOUT_MS || 5000),
    failClosed: process.env.SCAN_FAIL_CLOSED === 'true'
  };
}

function clamdInstream(host, port, buffer, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('扫描超时')); }, timeout);
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buffer.length, 0);
      socket.write(len);
      socket.write(buffer);
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      socket.write(end);
    });
    socket.on('data', (d) => {
      data += d.toString();
      if (data.includes('\n')) { clearTimeout(timer); socket.destroy(); resolve(data); }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 返回 { ok, skipped?, threat?, reason? }
async function scanBuffer(buffer, filename = '') {
  if (!enabled()) return { ok: true, skipped: true };
  const { host, port, timeout, failClosed } = config();
  if (!host) {
    return failClosed
      ? { ok: false, reason: '未配置 CLAMAV_HOST（fail-closed）' }
      : { ok: true, skipped: true, reason: '未配置病毒扫描服务' };
  }
  try {
    const result = await clamdInstream(host, port, buffer, timeout);
    if (/FOUND/.test(result)) return { ok: false, threat: true, reason: result.trim() || `检测到威胁: ${filename}` };
    return { ok: true };
  } catch (e) {
    return failClosed
      ? { ok: false, reason: '扫描失败: ' + e.message }
      : { ok: true, skipped: true, reason: '扫描失败: ' + e.message };
  }
}

module.exports = { enabled, config, scanBuffer, clamdInstream };
