// ===== 极简 SMTP 客户端（零依赖）=====
// 支持：明文 / STARTTLS / 隐式 TLS(465)，AUTH LOGIN / AUTH PLAIN。
// 仅覆盖告警邮件所需的最小命令集，异常统一抛出便于 notifier 记录失败。
const net = require('node:net');
const tls = require('node:tls');

class Reader {
  constructor(socket) {
    this.buf = '';
    this.queue = [];
    this.waiters = [];
    socket.on('data', (d) => { this.buf += d.toString('utf8'); this._drain(); });
  }
  _drain() {
    let m;
    // 完整应答：以「三位码 + 空格」结尾的行（续行为「三位码 + 连字符」）
    while ((m = this.buf.match(/^([\s\S]*?)^(\d{3}) [^\n]*\r?\n/m))) {
      const end = m.index + m[0].length;
      const text = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const item = { code: Number(m[2]), text };
      const resolve = this.waiters.shift();
      if (resolve) resolve(item); else this.queue.push(item);
    }
  }
  next(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP 响应超时')), timeoutMs);
      this.waiters.push((v) => { clearTimeout(timer); resolve(v); });
    });
  }
}

function openSocket({ host, port, secure, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setTimeout(timeout);
    const onErr = (e) => { socket.destroy(); reject(e); };
    socket.once('error', onErr);
    socket.once('timeout', () => onErr(new Error('SMTP 连接超时')));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onErr);
      socket.setTimeout(0);
      socket.on('error', () => { /* 会话内错误由 reader 超时兜底 */ });
      resolve(socket);
    });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => {
      secured.removeListener('error', reject);
      resolve(secured);
    });
    secured.once('error', reject);
  });
}

function b64(v) { return Buffer.from(String(v), 'utf8').toString('base64'); }

async function sendMail(opts) {
  const host = opts.host;
  const port = Number(opts.port || 587);
  const secure = opts.secure === true || port === 465;
  const timeout = Number(opts.timeout || 15000);
  const from = opts.from;
  const recipients = String(opts.to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!host || !from || !recipients.length) throw new Error('SMTP 配置不完整（host/from/to）');

  let socket = await openSocket({ host, port, secure, timeout });
  let reader = new Reader(socket);
  const cmd = async (line) => { socket.write(line + '\r\n'); return reader.next(timeout); };
  const expect = (r, codes, label) => {
    if (!codes.includes(r.code)) throw new Error(`${label} 失败: ${r.code} ${r.text.split(/\r?\n/).pop()}`);
    return r;
  };

  try {
    expect(await reader.next(timeout), [220], '连接');
    let ehlo = expect(await cmd(`EHLO ${opts.helo || 'localhost'}`), [250], 'EHLO');

    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      expect(await cmd('STARTTLS'), [220], 'STARTTLS');
      socket = await upgradeTls(socket, host);
      reader = new Reader(socket);
      await cmd(`EHLO ${opts.helo || 'localhost'}`);
    }

    if (opts.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        expect(await cmd(`AUTH PLAIN ${b64(`\0${opts.user}\0${opts.pass || ''}`)}`), [235], 'AUTH PLAIN');
      } else {
        expect(await cmd('AUTH LOGIN'), [334], 'AUTH LOGIN');
        expect(await cmd(b64(opts.user)), [334], 'AUTH 用户名');
        expect(await cmd(b64(opts.pass || '')), [235], 'AUTH 密码');
      }
    }

    expect(await cmd(`MAIL FROM:<${from}>`), [250], 'MAIL FROM');
    for (const rcpt of recipients) expect(await cmd(`RCPT TO:<${rcpt}>`), [250, 251], `RCPT TO ${rcpt}`);
    expect(await cmd('DATA'), [354], 'DATA');

    const headers = [
      `From: ${opts.fromName ? `${opts.fromName} <${from}>` : from}`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${opts.subject || ''}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64'
    ].join('\r\n');
    const body = Buffer.from(String(opts.text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    socket.write(headers + '\r\n\r\n' + body + '\r\n.\r\n');
    expect(await reader.next(timeout), [250], '发送正文');

    try { await cmd('QUIT'); } catch (_) { /* 忽略退出异常 */ }
    return true;
  } finally {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  }
}

function configFromEnv(env = process.env) {
  const { secret } = require('../../secrets');
  return {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: secret('SMTP_PASS') || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
    fromName: env.SMTP_FROM_NAME || '电商 AI 平台',
    helo: env.SMTP_HELO || 'localhost'
  };
}

module.exports = { sendMail, configFromEnv };
