/**
 * license.js — 注册码机制（一码一机）
 *
 * 设计要点：
 *  1. 机器指纹 = SHA256(主板序列号 | MachineGuid | 主网卡 MAC)，
 *     机器码 = 指纹前 8 字节十六进制，格式 XXXX-XXXX-XXXX-XXXX，用户发给管理员。
 *  2. 注册码 = Base32( 版本(1B) + 指纹8B + 签发日(2B，自 2026-01-01 的天数) + 有效期天数(2B，0=永久) + Ed25519签名(64B) )
 *     私钥只存在独立注册机（license-admin，不进安装包），应用内只内置公钥 → 无法伪造注册码。
 *  3. 防时间回拨：受信时间 = max(系统时间, 历史最大时间)。历史最大时间存三处：
 *     userData/license-time.json + 同目录 .bak + Windows 注册表 HKCU(HMAC-SHA256 防篡改)。
 *     系统时间比受信时间回拨超过 24 小时 → 判定 clock_rollback，锁定应用直到时间校准。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');

const LICENSE_VERSION = 1;
const RAW_LEN = 77;            // 1 + 8 + 2 + 2 + 64
const EPOCH_2026 = Date.UTC(2026, 0, 1);
const ROLLBACK_TOLERANCE_MS = 24 * 3600 * 1000;

// 内置 Ed25519 公钥（私钥仅在独立注册机 license-admin/keypair.json 中）
const PUB_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAnSjo5anphuSpEPIvAyt3gj0YC8pgZMqYUPit8CsxuH8=',
  '-----END PUBLIC KEY-----',
].join('\n');

// ============ 联网卡密激活（Cloudflare Workers） ============
// 主域名 = 自定义域名（国内直连可达）；workers.dev 国内被墙仅作备用地址
// 环境变量 AISTUDIO_LICENSE_SERVER 可覆盖（联调用）
const LICENSE_SERVER_DEFAULT = 'https://rabbit123.indevs.in';
let _serverUrl = process.env.AISTUDIO_LICENSE_SERVER || LICENSE_SERVER_DEFAULT;
let _serverUrlOverride = null; // 测试覆盖
const NET_TIMEOUT_MS = 12000;

function getServerUrl() { return _serverUrlOverride ?? _serverUrl; }

/** 卡密格式判定：YJ 前缀 + 短码（离线注册码为 100+ 字符长码，不会误判） */
function isCardCode(code) {
  const n = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length >= 10 && n.length <= 20 && n.startsWith('YJ');
}

// —— 系统代理识别（客户开着「系统代理模式」VPN 时也能激活） ——
const net = require('net');
const tls = require('tls');
const { exec } = require('child_process');

function _envProxy() { return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''; }

let _regProxyCache = { at: 0, value: '' };
/** Windows 注册表系统代理（ProxyEnable=1 时），缓存 60 秒；非 win32 返回空 */
function _registryProxy() {
  if (process.platform !== 'win32') return '';
  const now = Date.now();
  if (now - _regProxyCache.at < 60000) return _regProxyCache.value;
  _regProxyCache.at = now;
  _regProxyCache.value = new Promise((resolve) => {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    exec(`reg query "${base}" /v ProxyEnable & reg query "${base}" /v ProxyServer`, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      try {
        if (err || !/ProxyEnable\s+REG_SZ\s+0x1/.test(stdout || '')) return resolve('');
        const m = (stdout || '').match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (!m) return resolve('');
        let v = m[1];
        if (v.includes('=')) {
          const parts = v.split(';').map((s) => s.trim()).filter(Boolean);
          const hit = parts.find((s) => s.startsWith('https=')) || parts.find((s) => s.startsWith('http=')) || parts[0];
          v = hit.split('=').pop();
        }
        resolve(v && /^[a-zA-Z0-9.:-]+$/.test(v) ? (v.includes('://') ? v : 'http://' + v) : '');
      } catch { resolve(''); }
    });
  }).then((v) => { _regProxyCache.value = v; return v; });
  return _regProxyCache.value;
}

/** 经代理建立 CONNECT 隧道到 targetHost:targetPort */
function _tunnel(targetHost, targetPort, proxyUrl) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(proxyUrl); } catch { return reject(new Error('代理地址无效')); }
    const sock = net.connect(Number(p.port || 8080), p.hostname, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        if (/^HTTP\/1\.[01] 200/.test(buf)) resolve(sock);
        else { sock.destroy(); reject(new Error('代理隧道失败')); }
      }
    };
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('代理连接超时')); });
    sock.on('error', reject);
    sock.on('data', onData);
  });
}

/** 依次尝试 注册表代理 → 环境变量代理 → 直连；null 表示直连 */
async function _createConn(u) {
  const isHttps = u.protocol === 'https:';
  const host = u.hostname;
  const port = Number(u.port || (isHttps ? 443 : 80));
  const candidates = [];
  try { const reg = await _registryProxy(); if (reg) candidates.push(reg); } catch { /* 忽略 */ }
  const envP = _envProxy();
  if (envP && !candidates.includes(envP)) candidates.push(envP);
  for (const proxy of candidates) {
    try {
      const sock = await _tunnel(host, port, proxy);
      return isHttps ? tls.connect({ socket: sock, servername: host }) : sock;
    } catch { /* 换下一个候选 */ }
  }
  return null; // 直连
}

/** 主进程发起 JSON POST（自动识别系统代理） */
async function _netPost(urlPath, body) {
  const u = new URL(getServerUrl() + urlPath);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
  const conn = await _createConn(u);
  return await new Promise((resolve, reject) => {
    try {
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: NET_TIMEOUT_MS,
        ...(conn ? { createConnection: () => conn } : {}),
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('响应解析失败')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', reject);
      req.end(data);
    } catch (e) { reject(e); }
  });
}

/** 校验服务器签发的授权（Ed25519，负载 = v1|卡密|指纹|到期时间） */
function _verifyNetworkSig(code, fingerprint, expiryTime, sig) {
  try {
    const payload = `v1|${String(code).toUpperCase().replace(/[^0-9A-Z]/g, '')}|${String(fingerprint).toLowerCase()}|${Number(expiryTime) || 0}`;
    return crypto.verify(null, Buffer.from(payload, 'utf8'), crypto.createPublicKey(_pubKey()), Buffer.from(sig, 'base64'));
  } catch { return false; }
}

/** 静默心跳：封禁/过期（到期不宽限）时清除本地授权 */
async function _heartbeat() {
  try {
    const rec = readLicenseRecord();
    if (!rec || rec.mode !== 'network' || !getServerUrl()) return;
    const { digest } = await _fingerprint();
    const res = await _netPost('/api/verify', { code: rec.code, fingerprint: digest.toString('hex') });
    if (res && !res.ok && (res.reason === 'revoked' || res.reason === 'expired' || res.reason === 'mismatch')) {
      try { fs.unlinkSync(licenseFile()); } catch { /* 忽略 */ }
    }
  } catch { /* 断网/服务器不可达：忽略，本地授权继续有效 */ }
}

// ============ 测试钩子（仅测试使用） ============
const _test = {
  fpDigestOverride: null,   // Buffer(32)
  publicKeyOverride: null,  // PEM string
  dataDirOverride: null,
  registryDisabled: false,
};
function _pubKey() { return _test.publicKeyOverride || PUB_KEY_PEM; }

// ============ Base32（RFC4648，无填充） ============
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32Decode(str) {
  let bits = 0, value = 0;
  const bytes = [];
  const clean = String(str || '').toUpperCase();
  for (let i = 0; i < clean.length; i++) {
    const idx = B32.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

// ============ 机器指纹采集 ============
function runCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout || ''));
      });
    } catch { resolve(''); }
  });
}

/** 主网卡 MAC（排除虚拟网卡/蓝牙/回环） */
function pickMac() {
  const VIRTUAL = /virtual|vmware|vbox|virtualbox|hyper-v|vethernet|loopback|bluetooth|hamachi|tap|tun|docker|wsl|qemu/i;
  const PHYSICAL = /^(以太网|ethernet|wi-?fi|wlan|en\d|eth\d|本地连接)/i;
  const cands = [];
  const ifs = os.networkInterfaces() || {};
  for (const name of Object.keys(ifs)) {
    if (VIRTUAL.test(name)) continue;
    for (const it of ifs[name] || []) {
      if (!it || it.internal) continue;
      const mac = String(it.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') continue;
      cands.push({ name, mac, score: PHYSICAL.test(name) ? 0 : 1 });
    }
  }
  if (!cands.length) return '';
  cands.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return cands[0].mac.toUpperCase();
}

async function _collectFingerprintParts() {
  const parts = { board: '', guid: '', mac: pickMac() };
  if (process.platform === 'win32') {
    // 主板序列号：wmic 优先（快），缺失时退 PowerShell CIM（新版 Win11 已移除 wmic）
    let out = await runCmd('wmic', ['baseboard', 'get', 'serialnumber']);
    let m = out.match(/SerialNumber\s*\r?\n\s*(\S+)/i);
    if (m) parts.board = m[1];
    if (!parts.board) {
      out = await runCmd('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_BaseBoard).SerialNumber']);
      parts.board = String(out || '').trim().replace(/\s+/g, ' ');
    }
    if (/default string|none|to be filled|unknown/i.test(parts.board)) parts.board = '';
    // Windows 安装唯一标识 MachineGuid（重装系统才会变）
    out = await runCmd('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (m) parts.guid = m[1];
  } else if (process.platform === 'darwin') {
    const out = await runCmd('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const m = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    if (m) parts.board = m[1];
  }
  return parts;
}

let _fpCache = null; // { digest: Buffer(32), parts }
async function _fingerprint() {
  if (_test.fpDigestOverride) {
    return { digest: _test.fpDigestOverride, parts: { board: 'test', guid: 'test', mac: 'test' } };
  }
  if (_fpCache) return _fpCache;
  const parts = await _collectFingerprintParts();
  const material = ['aistudio-fp-v1', parts.board || '', parts.guid || '', parts.mac || ''].join('|');
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest();
  _fpCache = { digest, parts };
  return _fpCache;
}

/** 机器码：指纹前 8 字节十六进制，XXXX-XXXX-XXXX-XXXX */
async function getMachineCode() {
  const { digest } = await _fingerprint();
  return formatMachineCode(digest.subarray(0, 8).toString('hex').toUpperCase());
}
function formatMachineCode(hex16) {
  const h = String(hex16 || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 16).padEnd(16, '0');
  return h.match(/.{4}/g).join('-');
}

// ============ 数据目录 ============
function dataDir() {
  if (_test.dataDirOverride) return _test.dataDirOverride;
  try { return app.getPath('userData'); } catch { return os.tmpdir(); }
}
function licenseFile() { return path.join(dataDir(), 'license.json'); }
function timeFile() { return path.join(dataDir(), 'license-time.json'); }
function timeFileBak() { return path.join(dataDir(), 'license-time.bak'); }

// ============ 防时间回拨：受信时间三处存储 ============
function _timeHmac(digest, t) {
  return crypto.createHmac('sha256', Buffer.concat([digest, Buffer.from('aistudio-time-v1')]))
    .update(String(t)).digest('hex');
}

function _readTimeCandidates(digest) {
  const out = [];
  const tryJson = (p) => {
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = Number(obj.t);
      if (Number.isFinite(t) && obj.tag === _timeHmac(digest, t)) out.push(t);
    } catch { /* 缺失/损坏忽略 */ }
  };
  tryJson(timeFile());
  tryJson(timeFileBak());
  if (!_test.registryDisabled) {
    // 同步读取注册表（reg query 阻塞调用线程在主进程初始化阶段可接受；实际用 execFile 异步）
  }
  return out;
}

function _readTimeRegistry(digest) {
  return new Promise((resolve) => {
    if (_test.registryDisabled) return resolve(null);
    if (process.platform === 'win32') {
      execFile('reg', ['query', 'HKCU\\Software\\AIStudio', '/v', 'LicenseGuard'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout || '').match(/LicenseGuard\s+REG_SZ\s+(\d+):([0-9a-f]{64})/i);
        if (!m) return resolve(null);
        const t = Number(m[1]);
        resolve(t === t && m[2] === _timeHmac(digest, t) ? t : null);
      });
    } else if (process.platform === 'darwin') {
      execFile('defaults', ['read', 'com.zhrccp.aistudio', 'LicenseGuard'], { timeout: 5000 }, (err, stdout) => {
        const m = String(stdout || '').trim().match(/^(\d+):([0-9a-f]{64})$/i);
        if (!m) return resolve(null);
        const t = Number(m[1]);
        resolve(t === t && m[2] === _timeHmac(digest, t) ? t : null);
      });
    } else {
      resolve(null);
    }
  });
}

function _writeTimeEverywhere(t, digest) {
  const payload = JSON.stringify({ t, tag: _timeHmac(digest, t) });
  try { fs.mkdirSync(dataDir(), { recursive: true }); } catch { /* 目录已存在 */ }
  try { fs.writeFileSync(timeFile(), payload, 'utf8'); } catch { /* 忽略 */ }
  try { fs.writeFileSync(timeFileBak(), payload, 'utf8'); } catch { /* 忽略 */ }
  if (!_test.registryDisabled) {
    if (process.platform === 'win32') {
      execFile('reg', ['add', 'HKCU\\Software\\AIStudio', '/v', 'LicenseGuard', '/t', 'REG_SZ', '/d', `${t}:${_timeHmac(digest, t)}`, '/f'], { timeout: 5000, windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('defaults', ['write', 'com.zhrccp.aistudio', 'LicenseGuard', `${t}:${_timeHmac(digest, t)}`], { timeout: 5000 }, () => {});
    }
  }
}

/** 受信时间 = max(系统时间, 三处存储的历史最大时间)；返回 { trusted, rollback } */
async function _trustedTime(digest) {
  const now = Date.now();
  let stored = Math.max(null, ..._readTimeCandidates(digest).concat([0]));
  const regT = await _readTimeRegistry(digest);
  if (regT != null && regT > (stored || 0)) stored = regT;
  const rollback = stored != null && stored > 0 && now < stored - ROLLBACK_TOLERANCE_MS;
  const trusted = Math.max(now, stored || 0);
  if (trusted > (stored || 0)) _writeTimeEverywhere(trusted, digest);
  return { trusted, rollback };
}

// ============ 注册码解析 / 验签 ============
function formatLicenseCode(raw) {
  const s = b32Encode(raw);
  return s.match(/.{1,6}/g).join('-');
}

/**
 * 生成注册码（注册机与测试共用）：fp8Hex 16 位十六进制
 */
function signCode(fp8Hex, issuedDays, expiryDays, privPem) {
  const fp8 = Buffer.from(String(fp8Hex).replace(/[^0-9a-fA-F]/g, ''), 'hex');
  if (fp8.length !== 8) throw new Error('指纹必须为 16 位十六进制');
  const payload = Buffer.alloc(13);
  payload[0] = LICENSE_VERSION;
  fp8.copy(payload, 1);
  payload.writeUInt16BE(Math.max(0, issuedDays | 0), 9);
  payload.writeUInt16BE(Math.max(0, Math.min(65535, expiryDays | 0)), 11);
  const sig = crypto.sign(null, payload, crypto.createPrivateKey(privPem));
  return formatLicenseCode(Buffer.concat([payload, sig]));
}

/**
 * 验证注册码：返回 { ok, fp8Hex, issuedDays, expiryDays, error }
 */
function verifyCode(code) {
  const raw = b32Decode(String(code || ''));
  if (raw.length !== RAW_LEN) return { ok: false, error: '注册码格式不正确' };
  const payload = raw.subarray(0, 13);
  const sig = raw.subarray(13);
  if (payload[0] !== LICENSE_VERSION) return { ok: false, error: '注册码版本不支持' };
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, payload, crypto.createPublicKey(_pubKey()), sig);
  } catch { sigOk = false; }
  if (!sigOk) return { ok: false, error: '注册码无效（签名校验失败）' };
  return {
    ok: true,
    fp8Hex: payload.subarray(1, 9).toString('hex'),
    issuedDays: payload.readUInt16BE(9),
    expiryDays: payload.readUInt16BE(11),
  };
}

// ============ 授权状态 ============
function readLicenseRecord() {
  try { return JSON.parse(fs.readFileSync(licenseFile(), 'utf8')); } catch { return null; }
}

/**
 * 计算当前授权状态（不修改授权记录，仅推进受信时间）
 * status: ok | not_activated | expired | fingerprint_mismatch | clock_rollback | license_corrupt
 */
async function getState() {
  const { digest } = await _fingerprint();
  const machineCode = formatMachineCode(digest.subarray(0, 8).toString('hex').toUpperCase());
  const { trusted, rollback } = await _trustedTime(digest);

  const base = { machineCode, trustedTime: trusted, rollback };
  if (rollback) {
    return { ...base, status: 'clock_rollback', message: '检测到系统时间异常回拨，请校准系统时间后重新打开应用' };
  }

  const record = readLicenseRecord();
  if (!record || !record.code) {
    return { ...base, status: 'not_activated' };
  }

  // —— 联网卡密授权（mode:network）：本地验签 + 指纹绑定 + 到期不宽限 ——
  if (record.mode === 'network') {
    const fpHex = digest.toString('hex');
    if (record.fingerprint !== fpHex) {
      return { ...base, status: 'fingerprint_mismatch', message: '本机指纹与授权不匹配：一个卡密只能在一台电脑上使用' };
    }
    if (!_verifyNetworkSig(record.code, fpHex, record.expiryTime, record.sig)) {
      return { ...base, status: 'license_corrupt', message: '授权信息校验失败，请重新激活' };
    }
    const expiryTime = record.expiryTime > 0 ? record.expiryTime : null;
    if (expiryTime && trusted >= expiryTime) {
      return { ...base, status: 'expired', expiryTime, message: '授权已到期，请联系管理员续期' };
    }
    return {
      ...base,
      status: 'ok',
      expiryTime,
      activatedAt: record.activatedAt || null,
      codeMasked: maskCode(record.code),
    };
  }

  const v = verifyCode(record.code);
  if (!v.ok) {
    return { ...base, status: 'license_corrupt', message: '授权信息校验失败，请重新激活' };
  }
  const fp8Hex = digest.subarray(0, 8).toString('hex');
  if (v.fp8Hex !== fp8Hex) {
    return { ...base, status: 'fingerprint_mismatch', message: '本机指纹与注册码不匹配：一个注册码只能在一台机器上使用' };
  }
  let expiryTime = null;
  if (v.expiryDays > 0) {
    expiryTime = EPOCH_2026 + (v.issuedDays + v.expiryDays) * 86400000;
    if (trusted >= expiryTime) {
      return { ...base, status: 'expired', expiryTime, message: '授权已过期，请联系管理员获取新的注册码' };
    }
  }
  return {
    ...base,
    status: 'ok',
    expiryTime,
    activatedAt: record.activatedAt || null,
    codeMasked: maskCode(record.code),
  };
}

function maskCode(code) {
  const clean = String(code || '').replace(/-/g, '');
  if (clean.length < 12) return '****';
  return clean.slice(0, 6) + '…' + clean.slice(-6);
}

/**
 * 激活：校验注册码 → 绑定当前机器 → 落盘授权记录
 */
async function activate(codeRaw) {
  const { digest } = await _fingerprint();
  const machineCode = formatMachineCode(digest.subarray(0, 8).toString('hex').toUpperCase());
  const code = String(codeRaw || '').trim();
  if (!code) return { ok: false, error: '请输入卡密或注册码', state: await getState() };

  // —— 联网卡密激活：YJ- 卡密格式 且 已配置服务器 → 服务器绑定指纹并签发授权；
  //    长码（离线注册码）始终走本地验签，向后兼容 ——
  if (getServerUrl() && isCardCode(code)) {
    let res;
    try {
      res = await _netPost('/api/activate', {
        code,
        fingerprint: digest.toString('hex'),
        machineCode,
        platform: process.platform,
        version: LICENSE_VERSION,
      });
    } catch (e) {
      return { ok: false, error: '无法连接激活服务器，请检查网络后重试；若开启了代理/VPN，请尝试全局(TUN)模式', state: await getState() };
    }
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || '激活失败，请检查卡密', state: await getState() };
    }
    const lic = res.license || {};
    const fpHex = digest.toString('hex');
    if (String(lic.fingerprint || '') !== fpHex) {
      return { ok: false, error: '授权数据异常（指纹不匹配），请重试', state: await getState() };
    }
    if (!_verifyNetworkSig(lic.code, fpHex, lic.expiryTime, res.sig)) {
      return { ok: false, error: '授权签名校验失败，请重试', state: await getState() };
    }
    const record = {
      mode: 'network',
      version: 2,
      code: lic.code,
      fingerprint: fpHex,
      expiryTime: lic.expiryTime || 0,
      issuedAt: lic.issuedAt || Date.now(),
      sig: res.sig,
      activatedAt: Date.now(),
      machineCode,
    };
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(licenseFile(), JSON.stringify(record, null, 2), 'utf8');
    const state = await getState();
    if (state.status === 'ok') return { ok: true, state };
    return { ok: false, error: state.message || '激活校验未通过', state };
  }

  const v = verifyCode(code);
  if (!v.ok) return { ok: false, error: v.error, state: await getState() };

  const fp8Hex = digest.subarray(0, 8).toString('hex');
  if (v.fp8Hex !== fp8Hex) {
    return {
      ok: false,
      error: '注册码与本机不匹配：注册码绑定机器指纹，一个注册码只能在一台机器上激活',
      state: await getState(),
    };
  }

  const { trusted, rollback } = await _trustedTime(digest);
  const expiryTime = v.expiryDays > 0 ? EPOCH_2026 + (v.issuedDays + v.expiryDays) * 86400000 : null;
  if (expiryTime && trusted >= expiryTime) {
    return { ok: false, error: '该注册码已过期，请联系管理员获取新的注册码', state: await getState() };
  }

  const record = {
    code: formatLicenseCode(b32Decode(code)),
    activatedAt: Date.now(),
    machineCode,
    fingerprint: digest.toString('hex'),
    expiryTime,
    version: LICENSE_VERSION,
  };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(licenseFile(), JSON.stringify(record, null, 2), 'utf8');

  const state = await getState();
  // 回拨状态下即使激活成功也保持锁定（时间异常优先级最高）
  if (state.status === 'ok') return { ok: true, state };
  return { ok: false, error: state.message || '激活校验未通过', state };
}

/** 启动时初始化：预热指纹 + 推进受信时间 + 联网授权静默心跳；返回状态 */
async function init() {
  const state = await getState();
  // 心跳（异步不阻塞）：封禁/到期由服务器判定后清除本地授权；断网时本地授权继续有效
  if (state.status !== 'not_activated' && getServerUrl()) {
    _heartbeat().catch(() => {});
  }
  // 运行期间周期推进受信时间 + 每 30 分钟心跳一次
  if (!init._timer) {
    init._timer = setInterval(() => {
      _fingerprint().then(({ digest }) => _trustedTime(digest)).catch(() => {});
      if (getServerUrl()) _heartbeat().catch(() => {});
    }, 30 * 60 * 1000);
    if (init._timer.unref) init._timer.unref();
  }
  return state;
}

module.exports = {
  getMachineCode,
  getState,
  activate,
  init,
  // 供无头测试使用
  _test: {
    setFingerprintDigest(hex) { _test.fpDigestOverride = hex ? Buffer.from(hex, 'hex') : null; _fpCache = null; },
    setPublicKey(pem) { _test.publicKeyOverride = String(pem); },
    setDataDir(dir) { _test.dataDirOverride = dir; },
    setRegistryDisabled(v) { _test.registryDisabled = !!v; },
    setServerUrl(url) { _serverUrlOverride = url || null; },
    isCardCode,
    heartbeat: _heartbeat,
    signCode,
    verifyCode,
    b32Encode,
    b32Decode,
    formatMachineCode,
    readLicenseRecord,
    writeTrustedTime(t) { return _fingerprint().then(({ digest }) => _writeTimeEverywhere(t, digest)); },
    EPOCH_2026,
    RAW_LEN,
  },
};
