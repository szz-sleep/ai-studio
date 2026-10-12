/**
 * auth.js — 本地多用户账号（应用内第二级门禁，与卡密的"机器级"门禁相互独立）
 *
 * 设计要点：
 * - 账号仅存本机（userData/accounts.json），零服务器依赖，离线可用
 * - uid = SHA256('yj-user:' + 用户名归一化) 前 24 位十六进制：
 *   忘密码删除 accounts.json 后，同名重新注册可接回原工作空间数据（数据按 uid 前缀隔离）
 * - 密码 PBKDF2-SHA256(60000 轮) + 16 字节随机盐，比较用 timingSafeEqual
 * - 会话：登录后写入 db.session；remembered=false 的会话只保存在内存，
 *   应用重启（load() 重新读盘）即失效；remembered=true 的会话跨重启保留
 * - 工作空间隔离由渲染层 ScopedStore 按 uid 前缀实现，本模块只负责身份
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let _app = null; // 延迟获取 electron.app，便于无头单元测试直接 require
function app() { return _app || (_app = require('electron').app); }

let _testMode = false;
function setTestMode(v) { _testMode = !!v; }

function file() { return path.join(app().getPath('userData'), 'accounts.json'); }

let _db = null;
function load() {
  if (_db) return _db;
  try { _db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { _db = {}; }
  if (!_db.users || typeof _db.users !== 'object') _db.users = {};
  // 会话恢复：只有"记住登录"的会话能在重启后存活
  if (!_db.session || !_db.session.remembered || !_db.session.uid) _db.session = null;
  return _db;
}

function save() {
  try {
    const p = file();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn('[auth] 账号保存失败:', e.message);
  }
}

function normalizeUsername(u) { return String(u || '').trim().toLowerCase(); }

/** uid 由用户名稳定派生：同名账号（无论大小写/首尾空格）永远对应同一工作空间 */
function uidFor(username) {
  return crypto.createHash('sha256')
    .update('yj-user:' + normalizeUsername(username))
    .digest('hex')
    .slice(0, 24);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 60000, 32, 'sha256').toString('hex');
}

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/;

function register(username, password) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) return { ok: false, error: '用户名需 2-24 位，可含中文、字母、数字、下划线' };
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return { ok: false, error: '密码需 6-64 位' };
  }
  const d = load();
  const uid = uidFor(username);
  if (d.users[uid]) return { ok: false, error: '该用户名已存在，请直接登录' };
  const salt = crypto.randomBytes(16).toString('hex');
  d.users[uid] = { username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
  d.session = { uid, username, remembered: false };
  save();
  return { ok: true, user: { id: uid, username } };
}

function login(username, password, remember) {
  const d = load();
  const uid = uidFor(username);
  const rec = d.users[uid];
  if (!rec) return { ok: false, error: '用户不存在，请先注册' };
  const a = Buffer.from(hashPassword(password || '', rec.salt));
  const b = Buffer.from(rec.hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: '用户名或密码不正确' };
  }
  rec.lastLoginAt = Date.now();
  d.session = { uid, username: rec.username, remembered: !!remember };
  save();
  return { ok: true, user: { id: uid, username: rec.username } };
}

/** 渲染层启动时调用：enabled=false 表示测试/降级环境，渲染层不启用登录门禁 */
function session() {
  if (_testMode) return { enabled: false, loggedIn: false };
  const d = load();
  if (d.session && d.session.uid && d.users[d.session.uid]) {
    return { enabled: true, loggedIn: true, user: { id: d.session.uid, username: d.session.username } };
  }
  return { enabled: true, loggedIn: false };
}

function logout() {
  const d = load();
  d.session = null;
  save();
  return { ok: true };
}

/**
 * 注销当前登录用户（不可恢复）：
 * 删除账号记录 + 清除会话 + 删除其历史工作空间目录（Documents/AI Studio/history/<uid>）。
 * 浏览器存储里的工作空间数据（u:<uid>: 前缀）由渲染层在确认后清理。
 */
function deleteCurrent() {
  const d = load();
  if (!d.session || !d.session.uid) return { ok: false, error: '当前没有登录的用户' };
  const uid = d.session.uid;
  if (!d.users[uid]) { d.session = null; save(); return { ok: false, error: '用户不存在' }; }
  const username = d.users[uid].username;
  delete d.users[uid];
  d.session = null;
  save();
  try {
    const dir = path.join(app().getPath('documents'), 'AI Studio', 'history', uid);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn('[auth] 删除用户工作空间目录失败:', e.message);
  }
  return { ok: true, username };
}

/** 主进程侧当前登录用户（历史落盘目录按此隔离）；未登录返回 null */
function currentUid() {
  const d = load();
  return (d.session && d.session.uid) || null;
}

function initIpc(ipcMain) {
  ipcMain.handle('auth:session', () => session());
  ipcMain.handle('auth:register', (e, p) => register(p && p.username, p && p.password));
  ipcMain.handle('auth:login', (e, p) => login(p && p.username, p && p.password, p && p.remember));
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:delete', () => deleteCurrent());
}

/** 测试辅助：清空内存缓存，模拟应用重启 */
function _resetForTest() { _db = null; }

module.exports = {
  setTestMode, register, login, session, logout, deleteCurrent, currentUid,
  uidFor, initIpc, _resetForTest,
};
