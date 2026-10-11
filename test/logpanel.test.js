/** 画布页日志面板显示回归：agent 隐藏历史+日志；canvas 隐藏历史、显示日志；其他页两者显示 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'aistudio-logpanel-test'));
const RESULT_FILE = path.join(__dirname, 'logpanel.result.txt');
const lines = [];
const out = (s) => { lines.push(s); fs.writeFileSync(RESULT_FILE, lines.join('\n')); };
let failures = 0;
const assert = (name, cond) => { if (cond) out(`PASS ${name}`); else { failures++; out(`FAIL ${name}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);
    const r = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const vis = el => el && el.style.display !== 'none';
        const hist = document.querySelector('.history-section');
        const log = document.getElementById('logPanel');
        const clickTab = t => document.querySelector('.tab-btn[data-tab="' + t + '"]').click();
        const wait = () => new Promise(res => setTimeout(res, 100));
        clickTab('t2v'); await wait();
        r.t2vHist = vis(hist); r.t2vLog = vis(log);
        clickTab('agent'); await wait();
        r.agentHist = vis(hist); r.agentLog = vis(log);
        clickTab('canvas'); await wait();
        r.canvasHist = vis(hist); r.canvasLog = vis(log);
        // 画布面板高度仍正常（不被日志面板挤压塌陷）
        r.canvasH = document.getElementById('tab-canvas').offsetHeight;
        clickTab('t2i'); await wait();
        r.t2iHist = vis(hist); r.t2iLog = vis(log);
        return r;
    })()`);
    assert('agent.bothHidden', !r.agentHist && !r.agentLog, r);
    assert('canvas.histHidden+logShown', !r.canvasHist && r.canvasLog, r);
    assert('canvas.panelHeightOK', r.canvasH > 300, r.canvasH);
    assert('t2v.bothShown', r.t2vHist && r.t2vLog, r);
    assert('t2i.bothShown', r.t2iHist && r.t2iLog, r);
    out(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    app.exit(failures === 0 ? 0 : 1);
});
