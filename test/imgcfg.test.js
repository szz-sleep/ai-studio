/**
 * imgcfg.test.js — 无头读取应用的 localStorage（API 配置），不外传、只写本地文件
 * 结果写 test/imgcfg.result.txt（带检查点，任何一步失败也能留下进度）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'imgcfg.result.txt');
const log = (s) => { try { fs.appendFileSync(OUT, s + '\n', 'utf8'); } catch {} };

try { fs.unlinkSync(OUT); } catch {}

// 与 main.js 一致：userData 指向 ai-studio，才能读到真实 localStorage
app.setPath('userData', path.join(app.getPath('appData'), 'ai-studio'));

app.whenReady().then(async () => {
  log('step1: app ready');
  let win = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
    log('step2: window created');
    try { await win.loadURL('file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/')); }
    catch (e) { log('loadFile err (continue anyway): ' + e.message); }
    log('step3: loaded, waiting...');
    await new Promise((r) => setTimeout(r, 3000));
    log('step4: dumping localStorage');
    const dump = await win.webContents.executeJavaScript('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))', true);
    const ls = JSON.parse(dump);
    log('step5: keys=' + Object.keys(ls).length + ' allKeys=' + Object.keys(ls).join(' | '));
    for (const [k, v] of Object.entries(ls)) {
      const key = k.replace(/^u:[^:]+:/, 'u:*:');
      if (!/opc_/.test(key)) continue;
      let val = v;
      if (/api_keys|platforms/.test(key)) {
        try {
          const o = JSON.parse(v);
          const mask = (s) => (typeof s === 'string' && s.length > 12 ? s.slice(0, 6) + '***' + s.slice(-4) : s);
          if (Array.isArray(o)) val = JSON.stringify(o.map((p) => ({ ...p, apiKey: mask(p.apiKey) })));
          else val = JSON.stringify(Object.fromEntries(Object.entries(o).map(([a, b]) => [a, mask(b)])));
        } catch { val = '<parse fail>'; }
      }
      log(`${k} = ${val}`);
    }
    log('done');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
  }
  app.exit(0);
}).catch((e) => { log('READY FATAL ' + (e && e.stack || e)); app.exit(1); });

setTimeout(() => { log('TIMEOUT guard'); app.exit(2); }, 30000);
