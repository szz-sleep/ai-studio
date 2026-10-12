/**
 * auth.test.js — 本地多用户账号无头测试（主进程侧）
 * 覆盖：uid 派生稳定性/归一化、注册校验、重复注册、登录验证、
 *       记住登录跨重启、不记住不保留会话、登出、多账号 uid 互异
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test\auth.test.js
 * 结果写 test/auth.result.txt
 */
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const RESULT_FILE = path.join(__dirname, 'auth.result.txt');
const RESULTS = [];
let passed = 0, failed = 0;
function out(s) { RESULTS.push(s); try { fs.writeFileSync(RESULT_FILE, RESULTS.join('\n'), 'utf8'); } catch (e) {} }
function assert(name, cond, extra) {
  if (cond) { passed++; out('PASS ' + name); }
  else { failed++; out('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'aistudio-auth-test-')));

app.whenReady().then(async () => {
  const A = require('../auth.js');
  A.setTestMode(false); // 直接测函数本身；门禁开关（enabled=false）只影响渲染层

  // 1. uid 派生：稳定 + 归一化（大小写/首尾空格）+ 长度
  const uid1 = A.uidFor('Alice');
  assert('uid 派生稳定：同名同 uid', uid1 === A.uidFor('Alice'));
  assert('uid 归一化：大小写/空格不影响', uid1 === A.uidFor('  alice  '));
  assert('uid 长度 24 且十六进制', /^[0-9a-f]{24}$/.test(uid1));
  assert('不同用户名 uid 不同', uid1 !== A.uidFor('bob'));

  // 2. 注册成功
  const reg = A.register('Alice', 'secret1');
  assert('注册成功', !!reg.ok, reg);
  assert('注册返回的 id 与派生 uid 一致', reg.ok && reg.user.id === uid1);
  assert('注册即建立会话', A.session().loggedIn === true && A.session().user.username === 'Alice');

  // 3. 重复注册（含大小写变体）拒绝
  const dup = A.register('ALICE', 'secret2');
  assert('重复注册（大小写变体）拒绝', !dup.ok && /已存在/.test(dup.error || ''));

  // 4. 非法输入校验
  assert('用户名过短拒绝', !A.register('a', 'secret1').ok);
  assert('密码过短拒绝', !A.register('charlie', '123').ok);
  assert('用户名含非法字符拒绝', !A.register('bad name!', 'secret1').ok);

  // 5. 登录验证
  const lg = A.login('alice', 'secret1');
  assert('正确密码登录成功', !!lg.ok, lg);
  assert('错误密码拒绝', !A.login('alice', 'wrong!').ok);
  assert('不存在用户拒绝', !A.login('nobody', 'secret1').ok);
  assert('登录后 currentUid 正确', A.currentUid() === uid1);

  // 6. 记住登录：跨重启保留
  A.login('alice', 'secret1', true);
  A._resetForTest();
  const s1 = A.session();
  assert('记住登录：重启后仍登录', s1.loggedIn === true && s1.user.id === uid1);

  // 7. 不记住：重启后需重新登录
  A.login('alice', 'secret1', false);
  A._resetForTest();
  const s2 = A.session();
  assert('不记住登录：重启后回到未登录', s2.loggedIn === false && s2.enabled === true);

  // 8. 登出
  A.login('alice', 'secret1', true);
  A.logout();
  A._resetForTest();
  assert('登出后回到未登录', A.session().loggedIn === false && A.currentUid() === null);

  // 9. 多账号 uid 互异（工作空间隔离前提）
  const rb = A.register('bob', 'secret2');
  assert('第二个账号注册成功', !!rb.ok, rb);
  assert('两账号 uid 互异', rb.ok && rb.user.id !== uid1);

  // 10. 密码哈希非明文存储
  const raw = fs.readFileSync(path.join(app.getPath('userData'), 'accounts.json'), 'utf8');
  assert('账号文件不包含明文密码', !raw.includes('secret1') && !raw.includes('secret2'));

  // 11. 注销用户（deleteCurrent）：删账号 + 清会话 + 删工作空间目录
  //  11a. 未登录时注销拒绝
  A._resetForTest(); A.logout();
  const delNone = A.deleteCurrent();
  assert('未登录时注销拒绝', !delNone.ok && /没有登录/.test(delNone.error || ''), delNone);
  //  11b. 登录后注销：账号删除、会话清空、历史目录删除
  const uDir = path.join(app.getPath('documents'), 'AI Studio', 'history', rb.user.id);
  fs.mkdirSync(path.join(uDir, '视频'), { recursive: true });
  fs.writeFileSync(path.join(uDir, '视频', 'a.mp4'), 'x');
  A.login('bob', 'secret2', true);
  const del = A.deleteCurrent();
  assert('注销返回 ok 与用户名', del.ok && del.username === 'bob', del);
  assert('注销后会话清空', A.session().loggedIn === false && A.currentUid() === null);
  const raw2 = fs.readFileSync(path.join(app.getPath('userData'), 'accounts.json'), 'utf8');
  const db2 = JSON.parse(raw2);
  assert('注销后账号记录已删除', !db2.users[rb.user.id]);
  assert('注销后历史工作空间目录已删除', !fs.existsSync(uDir));
  //  11c. 注销后同名可重新注册（uid 稳定 → 可接回原工作空间键）
  const reReg = A.register('BOB', 'secret3');
  assert('注销后同名可重新注册', !!reReg.ok, reReg);
  assert('重新注册接回原 uid（工作空间可找回）', reReg.ok && reReg.user.id === rb.user.id);
  //  11d. 别的用户不受影响：alice 仍在
  A._resetForTest();
  const lgAlice = A.login('alice', 'secret1');
  assert('注销 bob 不影响 alice', !!lgAlice.ok && A.session().user.username === 'Alice');

  out(`\n==== auth.test.js: ${passed} passed, ${failed} failed ====`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  out('FATAL ' + (e && e.stack || e));
  try { fs.writeFileSync(RESULT_FILE, RESULTS.join('\n'), 'utf8'); } catch {}
  app.exit(1);
});
