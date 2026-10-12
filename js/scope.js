/**
 * scope.js — 多用户工作空间的存储键命名空间
 *
 * 登录成功后 Auth 会调用 ScopedStore.setUid(uid)，此后所有模块通过
 * ScopedStore.key(name) 取键，得到 'u:<uid>:<name>'，实现按账号隔离；
 * 未登录/测试环境 uid 为 null，键名保持原样 —— 完全向后兼容旧数据与现有测试。
 */
(function () {
  'use strict';
  window.ScopedStore = {
    _uid: null,
    setUid(uid) { this._uid = uid || null; },
    get uid() { return this._uid; },
    key(name) { return this._uid ? ('u:' + this._uid + ':' + name) : name; }
  };
})();
