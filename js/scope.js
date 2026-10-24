/**
 * scope.js — 存储键命名空间（历史上曾用于多用户账号隔离）
 *
 * 多用户账号体系已移除：uid 恒为 null，ScopedStore.key(name) 始终返回原键名。
 * 保留该模块是为了兼容既有调用点与测试；首次运行时会把旧版按账号隔离的
 * 'u:<uid>:<name>' 数据一次性搬回无前缀空间（幂等，搬过的账号记录在标记键中）。
 */
(function () {
  'use strict';
  window.ScopedStore = {
    _uid: null,
    setUid(uid) { this._uid = uid || null; },
    get uid() { return this._uid; },
    key(name) { return this._uid ? ('u:' + this._uid + ':' + name) : name; }
  };

  // ===== 旧版多用户 localStorage 数据迁移（无前缀化）=====
  // 只拷贝不删除：目标键已存在则跳过；选"键最多"的账号作为迁回来源，可重复执行。
  try {
    const FLAG = 'aistudio_scope_migrated_v1';
    const ls = window.localStorage;
    if (ls && !ls.getItem(FLAG)) {
      const byUid = new Map(); // uid -> [[name, value], ...]
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const m = /^u:([^:]+):(.+)$/.exec(k);
        if (m) {
          if (!byUid.has(m[1])) byUid.set(m[1], []);
          byUid.get(m[1]).push([m[2], ls.getItem(k)]);
        }
      }
      if (byUid.size) {
        let best = null;
        for (const [uid, items] of byUid) {
          if (!best || items.length > best.items.length) best = { uid, items };
        }
        let copied = 0;
        for (const [name, value] of best.items) {
          if (ls.getItem(name) === null) { ls.setItem(name, value); copied++; }
        }
        console.log('[scope] 已把账号「' + best.uid + '」的 ' + copied + ' 条本地数据迁回共享空间');
      }
      ls.setItem(FLAG, '1');
    }
  } catch (e) {
    console.warn('[scope] 旧数据迁移失败（不影响使用）:', e && e.message);
  }
})();
