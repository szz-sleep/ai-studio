/**
 * license.test.js — 注册码机制无头测试
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test/license.test.js
 * 结果写 test/license.result.txt
 */
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESULTS = [];
let passed = 0, failed = 0;
async function T(name, fn) {
  try { await fn(); passed++; RESULTS.push('PASS ' + name); }
  catch (e) { failed++; RESULTS.push('FAIL ' + name + ' :: ' + (e && e.message || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '不相等') + `: 期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`); }

function mkKeyPair() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    pub: kp.publicKey.export({ type: 'spki', format: 'pem' }).trim(),
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(),
  };
}

app.whenReady().then(async () => {
  const L = require('../license.js');
  const FP = 'deadbeef12345678' + '0'.repeat(48); // 32 字节指纹十六进制
  const FP8 = 'deadbeef12345678';
  const kp = mkKeyPair();
  const kp2 = mkKeyPair(); // 冒充者的私钥（应验签失败）
  let tmpDir = null;

  const resetEnv = () => {
    L._test.setFingerprintDigest(FP);
    L._test.setPublicKey(kp.pub);
    L._test.setRegistryDisabled(true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
    L._test.setDataDir(tmpDir);
  };
  resetEnv();

  await T('真实机器码格式 XXXX-XXXX-XXXX-XXXX（真实指纹采集链路）', async () => {
    L._test.setFingerprintDigest(null);
    const mc = await L.getMachineCode();
    assert(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(mc), '机器码格式不对: ' + mc);
    const mc2 = await L.getMachineCode();
    eq(mc, mc2, '机器码两次采集应一致');
    L._test.setFingerprintDigest(FP); // 恢复固定指纹
  });

  await T('初始状态 not_activated', async () => {
    const st = await L.getState();
    eq(st.status, 'not_activated', '初始状态');
    eq(st.machineCode, 'DEAD-BEEF-1234-5678', '机器码应来自测试指纹');
  });

  await T('永久码激活成功 → ok', async () => {
    const code = L._test.signCode(FP8, 0, 0, kp.priv);
    const r = await L.activate(code);
    assert(r.ok, '激活应成功: ' + (r.error || ''));
    eq(r.state.status, 'ok', '激活后状态');
    assert(r.state.codeMasked && r.state.codeMasked.includes('…'), '应有掩码注册码');
  });

  await T('激活记录持久化：重新 getState 仍为 ok', async () => {
    const st = await L.getState();
    eq(st.status, 'ok', '重启后状态');
    const rec = L._test.readLicenseRecord();
    assert(rec && rec.code && rec.fingerprint === FP, 'license.json 记录应完整');
  });

  await T('冒充私钥签发的码 → 拒绝', async () => {
    const code = L._test.signCode(FP8, 0, 0, kp2.priv);
    const r = await L.activate(code);
    assert(!r.ok, '应拒绝');
    assert(/无效|签名/.test(r.error), '错误信息应指向签名无效: ' + r.error);
  });

  await T('换一台机器（指纹不同）的码 → 拒绝且提示一码一机', async () => {
    const code = L._test.signCode('0102030405060708', 0, 0, kp.priv);
    const r = await L.activate(code);
    assert(!r.ok, '应拒绝');
    assert(/一台/.test(r.error), '应提示一码一机: ' + r.error);
    eq(r.state.status, 'ok', '原授权应不受影响');
  });

  await T('过期码 → 拒绝激活', async () => {
    const code = L._test.signCode(FP8, 0, 1, kp.priv); // 2026-01-01 签发，1 天有效期
    const r = await L.activate(code);
    assert(!r.ok, '应拒绝');
    assert(/过期/.test(r.error), '应提示过期: ' + r.error);
  });

  await T('一年期码激活 → ok 且 expiryTime 存在', async () => {
    // 用未来签发日绕开过期判定：签发 10 天前、365 天有效期
    const nowDays = Math.floor((Date.now() - L._test.EPOCH_2026) / 86400000);
    const code = L._test.signCode(FP8, nowDays - 10, 365, kp.priv);
    const r = await L.activate(code);
    assert(r.ok, '激活应成功: ' + (r.error || ''));
    assert(r.state.expiryTime > Date.now(), '到期时间应在未来');
    // 恢复永久授权，供后续用例
    await L.activate(L._test.signCode(FP8, 0, 0, kp.priv));
  });

  await T('注册码归一化：小写/无横线/多余空格均可激活', async () => {
    const code = L._test.signCode(FP8, 0, 0, kp.priv);
    const messy = '  ' + code.toLowerCase().replace(/-/g, '').slice(0, 40) + ' ' + code.toLowerCase().replace(/-/g, '').slice(40) + '  ';
    const r = await L.activate(messy);
    assert(r.ok, '归一化激活应成功: ' + (r.error || ''));
  });

  await T('license.json 被改坏 → license_corrupt', async () => {
    fs.writeFileSync(path.join(tmpDir, 'license.json'), JSON.stringify({ code: 'AAAA-BBBB-CCCC' }), 'utf8');
    const st = await L.getState();
    eq(st.status, 'license_corrupt', '坏码状态');
    await L.activate(L._test.signCode(FP8, 0, 0, kp.priv)); // 恢复
  });

  await T('时间回拨检测：受信时间领先 5 天 → clock_rollback', async () => {
    await L._test.writeTrustedTime(Date.now() + 5 * 86400000);
    const st = await L.getState();
    eq(st.status, 'clock_rollback', '回拨状态');
  });

  await T('回拨期间激活永久码 → 拒绝（时间异常优先）', async () => {
    const code = L._test.signCode(FP8, 0, 0, kp.priv);
    const r = await L.activate(code);
    assert(!r.ok, '回拨期间应拒绝');
    eq(r.state.status, 'clock_rollback', '状态保持回拨');
  });

  await T('回拨恢复（清受信时间）→ ok', async () => {
    for (const f of ['license-time.json', 'license-time.bak']) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* 忽略 */ }
    }
    const st = await L.getState();
    eq(st.status, 'ok', '时间恢复后应 ok');
  });

  await T('受信时间文件被篡改（HMAC 不匹配）→ 视为无效而非采纳', async () => {
    const t = Date.now() + 10 * 86400000;
    fs.writeFileSync(path.join(tmpDir, 'license-time.json'), JSON.stringify({ t, tag: 'f'.repeat(64) }), 'utf8');
    const st = await L.getState();
    eq(st.status, 'ok', '篡改的时间文件不应生效');
  });

  await T('重置环境后全新机器：not_activated（模拟新装机）', async () => {
    resetEnv();
    const st = await L.getState();
    eq(st.status, 'not_activated', '新环境未激活');
  });

  const summary = `\n==== license.test.js: ${passed} passed, ${failed} failed ====`;
  fs.writeFileSync(path.join(__dirname, 'license.result.txt'), RESULTS.join('\n') + summary, 'utf8');
  console.log(summary);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  RESULTS.push('FATAL ' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, 'license.result.txt'), RESULTS.join('\n'), 'utf8');
  app.exit(1);
});
