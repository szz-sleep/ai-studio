/**
 * license-macpin.test.js — MAC 钉存机制无头测试
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test/license-macpin.test.js
 * 结果写 test/license-macpin.result.txt
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

function digestOf(board, guid, mac) {
  return crypto.createHash('sha256')
    .update(['aistudio-fp-v1', board || '', guid || '', mac || ''].join('|'), 'utf8')
    .digest('hex');
}

app.whenReady().then(async () => {
  // license.js 与本测试共享同一个 os 模块实例 → 直接改 networkInterfaces 模拟换网卡
  const realIfs = os.networkInterfaces;
  const setIfaces = (mac) => {
    os.networkInterfaces = mac ? () => ({ '以太网': [{ mac, internal: false }] }) : () => ({});
  };

  const L = require('../license.js');
  let tmpDir = null;
  const freshDir = () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-macpin-'));
    L._test.setDataDir(tmpDir);
    L._test.setRegistryDisabled(true);
    L._test.setFingerprintDigest(null);
    return tmpDir;
  };

  const BOARD = 'BOARD-SERIAL-XYZ', GUID = 'machine-guid-abc';

  await T('MAC 漂移（模拟重启换网卡）指纹应保持不变', async () => {
    freshDir();
    L._test.setPartsOverride({ board: BOARD, guid: GUID, mac: '' });
    setIfaces('AA:BB:CC:DD:EE:01');
    const d1 = digestOf(BOARD, GUID, 'AA:BB:CC:DD:EE:01');
    // 第一次采集：钉住 mac1；机器码来自 digest 前 8 字节
    const expectMc = (function fmt(hex) {
      const h = hex.slice(0, 16).toUpperCase();
      return h.match(/.{4}/g).join('-');
    })(d1);
    const mc1 = await L.getMachineCode();
    eq(mc1, expectMc, '首次指纹应来自当前 MAC');
    // 模拟重启后 MAC 变了
    setIfaces('AA:BB:CC:DD:EE:02');
    L._test.clearFingerprintCache();
    const mc2 = await L.getMachineCode();
    eq(mc2, expectMc, 'MAC 漂移后指纹必须不变（钉存生效）');
  });

  await T('钉存文件被清（杀毒误删）→ 用注册表；两者都无 → 重新钉当前 MAC', async () => {
    freshDir();
    L._test.setPartsOverride({ board: BOARD, guid: GUID, mac: '' });
    setIfaces('AA:BB:CC:DD:EE:11');
    await L.getMachineCode(); // 钉住 EE:11
    const expectMc = (function (hex) { const h = hex.slice(0, 16).toUpperCase(); return h.match(/.{4}/g).join('-'); })(
      digestOf(BOARD, GUID, 'AA:BB:CC:DD:EE:11'));
    fs.unlinkSync(path.join(tmpDir, 'license-mac.json'));
    L._test.clearFingerprintCache();
    eq(await L.getMachineCode(), expectMc, '文件被删后仍应恒定（同机无注册表时重钉同一 MAC）');
  });

  await T('篡改钉存 MAC（标签不符）→ 应回退当前 MAC，不采信篡改值', async () => {
    freshDir();
    L._test.setPartsOverride({ board: BOARD, guid: GUID, mac: '' });
    setIfaces('AA:BB:CC:DD:EE:21');
    await L.getMachineCode();
    const pinPath = path.join(tmpDir, 'license-mac.json');
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    fs.writeFileSync(pinPath, JSON.stringify({ mac: 'FF:FF:FF:FF:FF:FF'.replace(/:/g, ''), tag: pin.tag }), 'utf8');
    L._test.clearFingerprintCache();
    const expectMc = (function (hex) { const h = hex.slice(0, 16).toUpperCase(); return h.match(/.{4}/g).join('-'); })(
      digestOf(BOARD, GUID, 'AA:BB:CC:DD:EE:21'));
    eq(await L.getMachineCode(), expectMc, '篡改 MAC 不应被采信');
  });

  await T('别机的钉存拷贝过来（密钥不同）→ 不采信', async () => {
    freshDir();
    const pinPath = path.join(tmpDir, 'license-mac.json');
    // 用另一台机器的 board/guid 造一份合法 pin，拷到本机
    const otherKey = crypto.createHash('sha256').update(['aistudio-macpin-v1', 'OTHER-BOARD', 'OTHER-GUID'].join('|'), 'utf8').digest();
    const tag = crypto.createHmac('sha256', otherKey).update('AA:BB:CC:DD:EE:31').digest('hex');
    fs.writeFileSync(pinPath, JSON.stringify({ mac: 'AABBCCDDEE31', tag }), 'utf8');
    L._test.setPartsOverride({ board: BOARD, guid: GUID, mac: '' });
    setIfaces('AA:BB:CC:DD:EE:32');
    const expectMc = (function (hex) { const h = hex.slice(0, 16).toUpperCase(); return h.match(/.{4}/g).join('-'); })(
      digestOf(BOARD, GUID, 'AA:BB:CC:DD:EE:32'));
    eq(await L.getMachineCode(), expectMc, '别机 pin 不应被采信，应钉本机当前 MAC');
  });

  await T('无 board/guid 的机器不钉存（跟随当前 MAC）', async () => {
    freshDir();
    L._test.setPartsOverride({ board: '', guid: '', mac: '' });
    setIfaces('AA:BB:CC:DD:EE:41');
    const mc1 = await L.getMachineCode();
    assert(!fs.existsSync(path.join(tmpDir, 'license-mac.json')), '不应写 pin 文件');
    setIfaces('AA:BB:CC:DD:EE:42');
    L._test.clearFingerprintCache();
    const mc2 = await L.getMachineCode();
    assert(mc1 !== mc2, '无锚点时指纹随 MAC 变化（预期行为）');
  });

  await T('恢复环境', async () => {
    os.networkInterfaces = realIfs;
    L._test.setPartsOverride(null);
    L._test.setMacOverride(null);
    L._test.setFingerprintDigest('deadbeef12345678' + '0'.repeat(48));
  });

  RESULTS.push(`TOTAL pass=${passed} fail=${failed}`);
  require('fs').writeFileSync(path.join(__dirname, 'license-macpin.result.txt'), RESULTS.join('\n'));
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  RESULTS.push('FATAL ' + (e && e.stack || e));
  require('fs').writeFileSync(path.join(__dirname, 'license-macpin.result.txt'), RESULTS.join('\n'));
  app.exit(1);
});
