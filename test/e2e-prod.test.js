/**
 * e2e-prod.test.js — 端到端：应用真实激活代码路径 → 正式服务器（自定义域名直连）
 * 用一次性卡密跑通 activate → getState → 心跳，不落任何生产状态（专用临时目录+固定指纹）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const L = require('../license.js');
const results = [];
function T(name, fn) { return fn().then((ok) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); return ok; }).catch((e) => { results.push(`FAIL ${name} :: ${e.message}`); return false; }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const CODE = (process.env.E2E_CODE || '').trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prod-'));
  const FP = 'e2e0prod1fingerprint2test3case4'; // 64 hex chars? 需 64 位 hex
  const fpHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  L._test.setServerUrl('https://rabbit123.indevs.in');
  L._test.setDataDir(tmp);
  L._test.setFingerprintDigest(fpHex);
  L._test.setRegistryDisabled(true);

  await T('正式域名直连：卡密激活成功 → ok', async () => {
    const r = await L.activate(CODE);
    assert(r.ok, '激活应成功: ' + (r.error || ''));
    assert(r.state && r.state.status === 'ok', '状态应为 ok: ' + JSON.stringify(r.state));
    return true;
  });

  await T('激活记录持久化：重启后 getState 仍 ok', async () => {
    const st = await L.getState();
    assert(st.status === 'ok', '应为 ok: ' + JSON.stringify(st));
    return true;
  });

  await T('心跳：服务器确认绑定有效', async () => {
    await L._test.heartbeat();
    const st = await L.getState();
    assert(st.status === 'ok', '心跳后仍应 ok: ' + JSON.stringify(st));
    return true;
  });

  await T('换指纹（第二台机器）激活同一卡 → 拒绝', async () => {
    L._test.setFingerprintDigest('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const r = await L.activate(CODE);
    assert(!r.ok, '应被拒绝');
    L._test.setFingerprintDigest(fpHex);
    return true;
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, 'e2e-prod.result.txt'), results.join('\n') + `\n==== e2e-prod: ${results.filter(r => r.startsWith('PASS')).length} passed, ${results.filter(r => r.startsWith('FAIL')).length} failed ====\n`, 'utf8');
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { results.push('FATAL ' + e.message); fs.writeFileSync(path.join(__dirname, 'e2e-prod.result.txt'), results.join('\n'), 'utf8'); process.exit(1); });
