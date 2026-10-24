// 诊断2：renderAll 是否增量（改 mtype 后 body 是否重建）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-matdiag2-test'));

(async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(r => setTimeout(r, 1800));

    const html = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        const CM = CanvasModule;
        CM._projects().forEach(p => localStorage.removeItem('aistudio_canvas_project_' + p.id));
        localStorage.removeItem('aistudio_canvas_projects');
        await new Promise(r => setTimeout(r, 1200));
        // A: addNode 后再改 mtype + renderAll
        const m = CM.addNode('material', 300, 300);
        const before = !!document.querySelector('.cnode[data-id="' + m.id + '"] .cnode-mat-video');
        m.data.mtype = 'video';
        m.data.url = 'https://x.example.com/v.mp4';
        CM.renderAll();
        const after = !!document.querySelector('.cnode[data-id="' + m.id + '"] .cnode-mat-video');
        const btnAfter = !!document.querySelector('.cnode[data-id="' + m.id + '"] .cnode-act-matsync');
        // B: 模拟 matsingle 场景——先建一堆节点和边，再在 y=1800 建素材节点
        const v = CM.addNode('video', 100, 2200);
        const m2 = CM.addNode('material', 700, 2200, { mtype: 'video', url: 'https://x.example.com/v.mp4' });
        const el2 = document.querySelector('.cnode[data-id="' + m2.id + '"]');
        return JSON.stringify({
            beforeVideoEl: before, afterVideoEl: after, btnAfter,
            b_elExists: !!el2,
            b_btn: el2 ? !!el2.querySelector('.cnode-act-matsync') : null,
            b_video: el2 ? !!el2.querySelector('.cnode-mat-video') : null,
            b_html: el2 ? el2.innerHTML.substring(0, 200) : 'NO-EL',
            nodeCount: CM.nodes.length,
        });
    })()`);
    console.log('DIAG2 ' + html);
    fs.writeFileSync(path.join(__dirname, 'matdiag2.result.txt'), 'DIAG2 ' + html + '\n', 'utf8');
    app.exit(0);
})().catch(e => { console.error('FATAL', e); app.exit(1); });
