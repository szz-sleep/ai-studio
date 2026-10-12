/**
 * license-net.test.js — 卡密联网激活端到端测试
 * 本地起激活服务器（与 Cloudflare worker 共用 server-core），验证：
 * 生成/激活绑定/换机拒绝/解绑/心跳封禁锁定/到期锁定（不宽限）/服务器不可达/离线注册码兼容
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test/license-net.test.js
 * 结果写 test/license-net.result.txt
 */
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_DIR = 'D:/AI Studio/license-admin/server';
const { createLocalServer } = require(SERVER_DIR + '/local-server.js');

const RESULTS = [];
let passed = 0, failed = 0;
async function T(name, fn) {
  try { await fn(); passed++; RESULTS.push('PASS ' + name); }
  catch (e) { failed++; RESULTS.push('FAIL ' + name + ' :: ' + (e && e.message || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '不相等') + `: 期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`); }

function httpGetJson(port, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: apiPath, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ping 超时')));
  });
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'license-net-'));

app.whenReady().then(async () => {
  const L = require('../license.js');
  const kp = crypto.generateKeyPairSync('ed25519');
  const kpPriv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
  const kpPub = kp.publicKey.export({ type: 'spki', format: 'pem' }).trim();
  const FP_A = 'aaaa1111aaaa1111' + '0'.repeat(48);
  const FP_B = 'bbbb2222bbbb2222' + '0'.repeat(48);
  const FP8_A = 'aaaa1111aaaa1111';

  // 内存库（测试可直接改记录模拟时间流逝）
  // 内存库（保存不克隆：测试改 store._db 即直接改核心缓存，可模拟时间流逝）
  const store = { _db: null, async load() { return this._db; }, async save(db) { this._db = db; } };
  let handle = await createLocalServer({ keyPem: kpPriv, adminToken: 'test-admin', dbPath: 'unused', storage: store, port: 0 });
  const serverUrl = () => 'http://127.0.0.1:' + handle.port;

  L._test.setPublicKey(kpPub);
  L._test.setRegistryDisabled(true);
  L._test.setServerUrl(serverUrl());
  const tmpA = freshDir(), tmpB = freshDir();
  const useMachine = (fp, dir) => { L._test.setFingerprintDigest(fp); L._test.setDataDir(dir); };

  let permCode = '', dayCode = '';

  await T('服务端批量生成卡密（永久 + 1天）', async () => {
    const codes = await handle.core.createCodes(2, 0, '测试永久');
    const codes2 = await handle.core.createCodes(2, 1, '测试1天');
    eq(codes.length, 2, '永久卡数量');
    eq(codes2.length, 2, '1天卡数量');
    assert(/^YJ(-[23456789A-Z]{4}){3}$/.test(codes[0]), '卡密格式: ' + codes[0]);
    permCode = codes[0];
    dayCode = codes2[0];
  });

  await T('服务器 ping 可达', async () => {
    const ping = await httpGetJson(handle.port, '/api/ping');
    assert(ping.ok, 'ping 应成功');
  });

  await T('机器A激活永久卡 → ok（mode:network）', async () => {
    useMachine(FP_A, tmpA);
    const r = await L.activate(permCode);
    assert(r.ok, '激活应成功: ' + (r.error || ''));
    eq(r.state.status, 'ok', '状态');
    eq(r.state.expiryTime, null, '永久卡无到期时间');
    const rec = L._test.readLicenseRecord();
    eq(rec.mode, 'network', '记录模式');
    eq(rec.fingerprint, FP_A, '绑定指纹A');
  });

  await T('停掉服务器 → getState 仍 ok（本地验签授权，断网可用）', async () => {
    const port = handle.port;
    await handle.close();
    const st = await L.getState();
    eq(st.status, 'ok', '服务器不可达不影响已激活用户');
    handle = await createLocalServer({ keyPem: kpPriv, adminToken: 'test-admin', dbPath: 'unused', storage: store, port: 0 });
    eq(handle.port !== port, true, '新端口重启成功');
    L._test.setServerUrl(serverUrl());
  });

  await T('机器B激活同一卡 → 拒绝（一码一机）', async () => {
    useMachine(FP_B, tmpB);
    const r = await L.activate(permCode);
    assert(!r.ok, '应拒绝');
    assert(/绑定其他电脑/.test(r.error), '错误提示: ' + r.error);
  });

  await T('管理员解绑 → 机器B激活成功；机器A心跳被判定指纹不匹配 → 锁定', async () => {
    const u = await handle.core.unbindCode(permCode);
    assert(u.ok, '解绑应成功');
    const r = await L.activate(permCode);
    assert(r.ok, '解绑后机器B应激活成功: ' + (r.error || ''));
    // 机器A本地签名自洽，需心跳联网后由服务器判定 mismatch 并清除
    useMachine(FP_A, tmpA);
    const before = await L.getState();
    eq(before.status, 'ok', '心跳前本地仍自洽');
    await L._test.heartbeat();
    const st = await L.getState();
    eq(st.status, 'not_activated', '心跳判定不匹配后应锁定');
    useMachine(FP_B, tmpB);
  });

  await T('封禁 → 心跳后本地授权清除 → not_activated', async () => {
    const rev = await handle.core.revokeCode(permCode, true);
    assert(rev.ok, '封禁应成功');
    await L._test.heartbeat();
    const st = await L.getState();
    eq(st.status, 'not_activated', '封禁后应回到未激活');
  });

  await T('1天卡激活 → ok；激活时间拨回5天 → 心跳判定过期并锁定（不宽限）', async () => {
    const r = await L.activate(dayCode);
    assert(r.ok, '激活应成功: ' + (r.error || ''));
    assert(r.state.expiryTime > Date.now(), '到期时间在未来');
    const key = dayCode.replace(/-/g, '');
    const rec = store._db.codes[key];
    assert(rec, '服务端应存在该卡密记录');
    rec.activatedAt = Date.now() - 5 * 86400000;
    rec.boundAt = rec.activatedAt;
    await L._test.heartbeat();
    const st = await L.getState();
    eq(st.status, 'not_activated', '过期心跳后应锁定');
  });

  await T('服务器不可达 → 激活明确报错（不静默降级）', async () => {
    L._test.setServerUrl('http://127.0.0.1:9');
    const r = await L.activate('YJ-AAAA-BBBB-CCCC');
    assert(!r.ok, '应失败');
    assert(/无法连接激活服务器/.test(r.error), '错误信息: ' + r.error);
    L._test.setServerUrl(serverUrl());
  });

  await T('未配置服务器 → 离线注册码模式照常可用（向后兼容）', async () => {
    L._test.setServerUrl('');
    useMachine(FP_A, tmpA);
    const legacyCode = L._test.signCode(FP8_A, 0, 0, kpPriv);
    const r = await L.activate(legacyCode);
    assert(r.ok, '离线码激活应成功: ' + (r.error || ''));
    const st = await L.getState();
    eq(st.status, 'ok', '离线授权状态');
    const rec = L._test.readLicenseRecord();
    assert(rec.mode !== 'network', '应为离线记录');
  });

  await handle.close();
  const summary = `\n==== license-net.test.js: ${passed} passed, ${failed} failed ====`;
  fs.writeFileSync(path.join(__dirname, 'license-net.result.txt'), RESULTS.join('\n') + summary, 'utf8');
  console.log(summary);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  RESULTS.push('FATAL ' + (e && e.stack || e));
  try { fs.writeFileSync(path.join(__dirname, 'license-net.result.txt'), RESULTS.join('\n'), 'utf8'); } catch { /* */ }
  app.exit(1);
});
