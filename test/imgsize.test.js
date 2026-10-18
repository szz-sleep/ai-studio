/**
 * imgsize.test.js — ImageSize 尺寸计算逻辑单测（纯 Node，无需 electron）
 * 运行：node test/imgsize.test.js（用 node 跑需要把 image.js 当纯 JS eval——
 * 这里直接内联复制 ImageSize 逻辑源，防止双实现漂移：直接 require image.js 会因
 * document 不存在而炸，因此用 fs 读取源码提取 ImageSize 段执行）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'image.js'), 'utf8');
// 提取 RES_PRESETS 到 ImageSize 定义结束（const ImageSize = {...};）之间的纯计算代码
const start = src.indexOf('const RES_PRESETS');
const end = src.indexOf('// 兼容旧代码的全局映射');
if (start < 0 || end < 0) { console.error('extract fail'); process.exit(1); }
const code = src.slice(start, end);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.ImageSize = ImageSize; this.RES_PRESETS = RES_PRESETS;', sandbox);
const S = sandbox.ImageSize;
const P = sandbox.RES_PRESETS;

let passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'neq') + `: 期望 ${b} 实际 ${a}`); }

// —— 标准阶梯（未知模型）——
T('未知模型 16:9 各档标准尺寸', () => {
  eq(S.compute('some-model-x', '480P', '16:9').size, '854x480');
  eq(S.compute('some-model-x', '720P', '16:9').size, '1280x720');
  eq(S.compute('some-model-x', '1080P', '16:9').size, '1920x1080');
  eq(S.compute('some-model-x', '2K', '16:9').size, '2560x1440');
  eq(S.compute('some-model-x', '4K', '16:9').size, '3840x2160');
});
T('9:16 自动竖向切换', () => {
  eq(S.compute('m', '720P', '9:16').size, '720x1280');
  eq(S.compute('m', '4K', '9:16').size, '2160x3840');
});
T('其他比例短边对齐（4:3 / 21:9 / 1:1）', () => {
  eq(S.compute('m', '1080P', '4:3').size, '1440x1080');
  eq(S.compute('m', '1080P', '3:4').size, '810x1080');
  eq(S.compute('m', '720P', '21:9').size, '1680x720');
  eq(S.compute('m', '1080P', '1:1').size, '1080x1080');
});
T('未知分辨率回退 720P', () => {
  const r = S.compute('m', '999P', '16:9');
  eq(r.size, '1280x720'); eq(r.preset, '720P');
});

// —— 模型能力层 ——
T('Seedream 4.0：720P@16:9 正常', () => {
  const r = S.compute('doubao-seedream-4-0-250828', '720P', '16:9');
  eq(r.size, '1280x720'); eq(r.caps.label, 'Seedream 4.0');
});
T('Seedream 4.0：480P@16:9 低于 0.92M 自动升档', () => {
  const r = S.compute('doubao-seedream-4-0-250828', '480P', '16:9');
  eq(r.size, '1280x720'); eq(r.bumped, '720P');
});
T('Seedream 3.x：480P 不足 3.69M 自动升档到 2K', () => {
  const r = S.compute('doubao-seedream-3-0-t2i', '480P', '16:9');
  eq(r.bumped, '2K'); eq(r.size, '2560x1440');
});
T('Seedream 3.x：720P@16:9 也升档（2304x1296=2.98M < 3.69M）', () => {
  const r = S.compute('doubao-seedream-3-0-t2i', '720P', '16:9');
  eq(r.bumped, '2K'); eq(r.size, '2560x1440');
});
T('Seedream 3.x：2K@16:9 恰好满足不升档', () => {
  const r = S.compute('doubao-seedream-3-0-t2i', '2K', '16:9');
  eq(r.bumped, null); eq(r.size, '2560x1440');
});
T('Seedream 4K@16:9 不超上限', () => {
  const r = S.compute('doubao-seedream-4-0-250828', '4K', '16:9');
  eq(r.size, '3840x2160');
});
T('GPT Image：任意 WxH，比例精确控制（MUX）', () => {
  eq(S.compute('gpt-image-2', '1080P', '16:9').size, '1920x1080');
  eq(S.compute('gpt-image-2', '4K', '16:9').size, '3840x2160');
  eq(S.compute('gpt-image-2.5-flare-ad', '720P', '9:16').size, '720x1280');
  eq(S.compute('gpt-image-2', '720P', '1:1').size, '720x720');
});
T('GPT Image：-1K 型号上限 1024', () => {
  const r = S.compute('gpt-image-2-1K', '4K', '16:9');
  const [w, h] = r.size.split('x').map(Number);
  eq(r.caps.label, 'GPT Image');
  if (w > 1024 || h > 1024) throw new Error('超 1K 上限: ' + r.size);
});
T('结果尺寸全为偶数', () => {
  for (const res of Object.keys(P)) {
    for (const ratio of ['21:9', '16:9', '4:3', '3:4', '1:1', '9:16']) {
      const [w, h] = S.compute('m', res, ratio).size.split('x').map(Number);
      if (w % 2 || h % 2) throw new Error(`${res} ${ratio} -> ${w}x${h} 非偶数`);
    }
  }
});

console.log(`==== imgsize.test.js: ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
