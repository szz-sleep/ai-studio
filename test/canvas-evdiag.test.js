// 底层事件诊断：真实双击到底产生了什么事件序列
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-evdiag-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1800);

    await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        const CM = CanvasModule;
        CM._projects().forEach(p => localStorage.removeItem('aistudio_canvas_project_' + p.id));
        localStorage.removeItem('aistudio_canvas_projects');
        // 底层事件记录器
        window.__EV = [];
        ['mousedown','mouseup','click','dblclick'].forEach(t => {
            document.addEventListener(t, (e) => {
                window.__EV.push({ t, detail: e.detail, target: (e.target.className || e.target.tagName || '').toString().substring(0, 40),
                    x: e.clientX, y: e.clientY });
            }, true);
        });
        return true;
    })()`);
    await sleep(1200);

    const nid = await win.webContents.executeJavaScript(`CanvasModule.addNode('audio', 300, 200) && CanvasModule.nodes[CanvasModule.nodes.length-1].id`);
    await sleep(300);
    const c = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.cnode[data-id="' + '${nid}' + '"] .cnode-audio-wrap');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: { l: r.left, t: r.top, w: r.width, h: r.height } };
    })()`);

    console.log('CLICK-AT', JSON.stringify(c));
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 2 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 2 });
    await sleep(500);

    const ev = await win.webContents.executeJavaScript(`window.__EV`);
    const pick = await win.webContents.executeJavaScript(`(function(){ return typeof CanvasModule._pickLocalAudio; })()`);
    console.log('EVENTS', JSON.stringify(ev, null, 1));
    fs.writeFileSync(path.join(__dirname, 'evdiag.result.txt'), JSON.stringify({ c, ev, pick }, null, 2));
    setTimeout(() => app.exit(0), 300);
})();
