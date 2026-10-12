/**
 * auth.js — 本地多用户登录门禁（渲染层）
 *
 * 流程：License 激活通过 → 检查本地会话（记住登录可自动进入）
 *       → 未登录显示登录/注册遮罩 → 成功后 ScopedStore.setUid 并放行 App.init
 * - 无 electronAPI / 测试环境（auth:session 返回 enabled=false）：不拦截，直接放行
 * - 首次登录引导迁移旧版（未分账号）数据到当前账号工作空间
 * - 切换账号 = 登出 + 整页重载
 */
(function () {
  'use strict';
  const Api = window.electronAPI;
  const hasAuth = !!(Api && typeof Api.authSession === 'function');

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const overlay = () => document.getElementById('authOverlay');
  const msgEl = () => document.getElementById('authMsg');
  const userBadge = () => document.getElementById('userBadge');

  let mode = 'login'; // login | register
  let currentUser = null;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function showOverlay(registerMode) {
    mode = registerMode ? 'register' : 'login';
    const el = overlay();
    if (!el) return;
    el.classList.remove('hidden');
    document.getElementById('authTitle').textContent = registerMode ? '注册账号' : '登录 云镜AI Studio';
    document.getElementById('authSubmitBtn').textContent = registerMode ? '注 册' : '登 录';
    document.getElementById('authToggleLink').textContent = registerMode ? '已有账号？去登录' : '没有账号？注册一个';
    document.getElementById('authPassword2Row').classList.toggle('hidden', !registerMode);
    const u2 = document.getElementById('authPassword2');
    if (registerMode) u2.setAttribute('placeholder', '再次输入密码');
    else u2.value = '';
    msgEl().textContent = '';
    msgEl().classList.remove('activation-msg-err');
    // 自动恢复上次输入过的用户名（非敏感，方便多账号切换）
    document.getElementById('authUsername').value = localStorage.getItem('auth-last-username') || '';
  }

  function err(m) { msgEl().textContent = m; msgEl().classList.add('activation-msg-err'); }

  function badge(username) {
    const el = userBadge();
    if (!el) return;
    if (username) {
      el.textContent = username;
      el.classList.remove('hidden');
      el.title = '点击切换账号';
    } else {
      el.classList.add('hidden');
    }
  }

  function finish(user) {
    if (user) {
      currentUser = user;
      window.ScopedStore.setUid(user.id);
      badge(user.username);
      maybeMigrate(user);
    }
    const el = overlay();
    if (el) el.classList.add('hidden');
    resolveReady();
  }

  /** 旧版数据迁移：仅当当前账号工作空间为空、且本机存在未分账号的旧数据时提示一次 */
  async function maybeMigrate(user) {
    try {
      const ls = window.localStorage;
      let hasLegacy = false;
      let myEmpty = ls.getItem(window.ScopedStore.key('opc_api_keys')) === null
        && ls.getItem(window.ScopedStore.key('aistudio_canvas_projects')) === null;
      if (!myEmpty) return;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k === 'app-theme' || k.startsWith('u:') || k.startsWith('auth-')) continue;
        if (/^(opc_|aistudio_|h3-)/.test(k)) { hasLegacy = true; break; }
      }
      if (!hasLegacy) return;
      const ok = (window.UI && typeof UI.confirm === 'function')
        ? await UI.confirm('检测到本机已有未分账号的旧版数据。\n是否将其归入当前账号「' + user.username + '」的工作空间？\n（选"否"则使用空白工作空间，旧数据仍保留在本机）')
        : window.confirm('检测到本机已有未分账号的旧版数据，是否归入当前账号？');
      if (!ok) return;
      const snap = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k === 'app-theme' || k.startsWith('u:') || k.startsWith('auth-')) continue;
        if (/^(opc_|aistudio_|h3-)/.test(k)) snap.push([k, ls.getItem(k)]);
      }
      snap.forEach(([k, v]) => { try { ls.setItem(window.ScopedStore.key(k), v); } catch { /* 单键失败不阻断 */ } });
    } catch (e) { /* 迁移失败不影响使用 */ }
  }

  async function submit() {
    const btn = document.getElementById('authSubmitBtn');
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    const password2 = document.getElementById('authPassword2').value;
    const remember = document.getElementById('authRemember').checked;
    if (!username || !password) { err('请输入用户名和密码'); return; }
    if (mode === 'register' && password !== password2) { err('两次输入的密码不一致'); return; }
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = mode === 'register' ? '注册中…' : '登录中…';
    try {
      const r = mode === 'register'
        ? await Api.authRegister(username, password)
        : await Api.authLogin(username, password, remember);
      if (r && r.ok) {
        try { localStorage.setItem('auth-last-username', username); } catch { /* 忽略 */ }
        finish(r.user);
      } else {
        err((r && r.error) || (mode === 'register' ? '注册失败' : '登录失败'));
      }
    } catch (e) {
      err('请求失败：' + ((e && e.message) || e));
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  function bind() {
    document.getElementById('authSubmitBtn').addEventListener('click', submit);
    ['authUsername', 'authPassword', 'authPassword2'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
    document.getElementById('authToggleLink').addEventListener('click', () => {
      showOverlay(mode === 'login'); // 在登录/注册之间切换
    });
    const badgeEl = userBadge();
    if (badgeEl) badgeEl.addEventListener('click', async () => {
      if (!currentUser) return;
      const ok = (window.UI && typeof UI.confirm === 'function')
        ? await UI.confirm('切换账号将返回登录界面（当前工作空间数据已保存）。\n确定要切换账号吗？')
        : window.confirm('确定要切换账号吗？');
      if (!ok) return;
      try { await Api.authLogout(); } catch { /* 忽略 */ }
      window.location.reload();
    });
  }

  function boot() {
    if (!hasAuth) {
      // 无 preload / 无 auth API（无头测试、异常降级）：不拦截
      const el = overlay();
      if (el) el.classList.add('hidden');
      resolveReady();
      return;
    }
    bind();
    (async () => {
      try {
        const s = await Api.authSession();
        if (!s || s.enabled === false) { resolveReady(); return; } // 测试/降级：不拦
        if (s.loggedIn && s.user) { finish(s.user); return; }
        // 等 License 激活通过（激活遮罩负责那一步的交互），再要求登录
        for (;;) {
          let st = null;
          try { st = await Api.getLicenseState(); } catch { /* 忽略，继续等 */ }
          if (st && st.status === 'ok') break;
          await sleep(1000);
        }
        showOverlay(false);
      } catch (e) {
        // 会话查询异常：保守起见不拦（与无 auth API 行为一致）
        resolveReady();
      }
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Auth = { ready, get user() { return currentUser; } };
})();
