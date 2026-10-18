/** loadcheck.test.js — 加载 index.html 收集 console 错误（验证本次改动不炸页面） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'loadcheck.result.txt');
app.setPath('userData', path.join(app.getPath('appData'), 'ai-studio'));
app.whenReady().then(async () => {
  const errs = [];
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 3) errs.push(msg); });
  try { await win.loadFile(path.join(__dirname, '..', 'index.html')); } catch (e) { errs.push('load: ' + e.message); }
  await new Promise((r) => setTimeout(r, 4000));
  const sizeOk = await win.webContents.executeJavaScript(
    `typeof ImageSize !== 'undefined' && ImageSize.compute('m','1080P','16:9').size`
  , true).catch((e) => 'ERR ' + e.message);
  fs.writeFileSync(OUT, `size probe: ${sizeOk}\nerrors:\n${errs.join('\n') || '(none)'}`, 'utf8');
  app.exit(0);
});
setTimeout(() => app.exit(2), 30000);
