// 诊断：素材节点实际渲染的 DOM
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-matdiag-test'));

(async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(r => setTimeout(r, 1800));

    const html = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        const CM = CanvasModule;
        CM._projects().forEach(p => localStorage.removeItem('aistudio_canvas_project_' + p.id));
        localStorage.removeItem('aistudio_canvas_projects');
        const mf = CM.addNode('material', 300, 300);
        const mv = CM.addNode('material', 700, 300, { mtype: 'video', url: 'https://x.example.com/v.mp4' });
        const elF = document.querySelector('.cnode[data-id="' + mf.id + '"]');
        const elV = document.querySelector('.cnode[data-id="' + mv.id + '"]');
        return JSON.stringify({
            fExists: !!elF,
            fBtnRow: elF ? (elF.querySelector('.cnode-btn-row')?.innerHTML || 'NO-BTN-ROW').substring(0, 400) : 'NO-EL',
            fMatsync: elF ? !!elF.querySelector('.cnode-act-matsync') : null,
            vExists: !!elV,
            vMatsync: elV ? !!elV.querySelector('.cnode-act-matsync') : null,
            vBody: elV ? elV.querySelector('.cnode-body')?.innerHTML.substring(0, 300) : 'NO-EL',
            dataF: JSON.stringify(mf.data),
            dataV: JSON.stringify(mv.data),
        });
    })()`);
    console.log('DIAG ' + html);
    fs.writeFileSync(path.join(__dirname, 'matdiag.result.txt'), 'DIAG ' + html + '\n', 'utf8');
    app.exit(0);
})().catch(e => { console.error('FATAL', e); app.exit(1); });
