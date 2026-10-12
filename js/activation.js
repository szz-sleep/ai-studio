/**
 * activation.js — 注册码激活界面（一码一机）
 * 未激活/授权异常时显示全屏遮罩；license.getState() 返回 ok 后隐藏并放行应用。
 */
(function () {
  'use strict';
  const Api = window.electronAPI;
  if (!Api || typeof Api.getLicenseState !== 'function') {
    // 无 preload 的环境（无头测试/异常降级）：不拦截界面
    const el = document.getElementById('activationOverlay');
    if (el) el.classList.add('hidden');
    return;
  }

  const overlay = () => document.getElementById('activationOverlay');
  const msgEl = () => document.getElementById('activationMsg');
  const codeInput = () => document.getElementById('activationCodeInput');

  function setStatusMessage(st) {
    const map = {
      not_activated: '',
      expired: '授权已过期，请联系管理员获取新的注册码',
      fingerprint_mismatch: '本机指纹与注册码不匹配：一个注册码只能在一台电脑上使用',
      clock_rollback: '检测到系统时间异常回拨，请校准系统时间后重新打开应用',
      license_corrupt: '授权信息校验失败，请重新激活',
    };
    msgEl().textContent = map[st.status] || '';
    msgEl().classList.toggle('activation-msg-err', !!map[st.status]);
    if (st.status === 'clock_rollback') {
      // 时间异常时隐藏输入区，避免用户误以为激活能解决
      codeInput().disabled = true;
      const btn = document.getElementById('activationBtn');
      if (btn) btn.disabled = true;
    }
  }

  function applyState(st) {
    const el = overlay();
    if (!el) return;
    if (st && st.status === 'ok') {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const mc = document.getElementById('activationMachineCode');
    if (mc && st.machineCode) mc.textContent = st.machineCode;
    setStatusMessage(st || {});
  }

  async function refresh() {
    try {
      applyState(await Api.getLicenseState());
    } catch (e) {
      // 查询失败保守处理：保持遮罩，提示重试
      if (msgEl()) { msgEl().textContent = '授权状态读取失败，请重启应用'; msgEl().classList.add('activation-msg-err'); }
    }
  }

  async function doActivate() {
    const btn = document.getElementById('activationBtn');
    const code = (codeInput().value || '').trim();
    msgEl().classList.remove('activation-msg-err');
    if (!code) { msgEl().textContent = '请先粘贴注册码'; msgEl().classList.add('activation-msg-err'); return; }
    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const r = await Api.activateLicense(code);
      if (r && r.ok) {
        applyState(r.state);
      } else {
        msgEl().textContent = (r && r.error) || '激活失败，请检查注册码';
        msgEl().classList.add('activation-msg-err');
        if (r && r.state) applyState({ ...r.state, status: r.state.status === 'ok' ? r.state.status : r.state.status });
      }
    } catch (e) {
      msgEl().textContent = '激活请求失败：' + (e && e.message || e);
      msgEl().classList.add('activation-msg-err');
    } finally {
      btn.disabled = false;
      btn.textContent = '激 活';
    }
  }

  function bind() {
    const btn = document.getElementById('activationBtn');
    const copyBtn = document.getElementById('activationCopyBtn');
    const input = codeInput();
    if (btn) btn.addEventListener('click', doActivate);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const text = (document.getElementById('activationMachineCode') || {}).textContent || '';
      try {
        await navigator.clipboard.writeText(text.replace(/-/g, ''));
        copyBtn.textContent = '已复制';
      } catch {
        // 降级：选中方便手动复制
        copyBtn.textContent = '请手动复制';
      }
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1800);
    });
  }

  function boot() {
    bind();
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
