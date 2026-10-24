const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const os = require('os'); const fs = require('fs');
app.setPath('userData', path.join(os.tmpdir(), 'aistudio-hist-test'));
app.setPath('documents', path.join(os.tmpdir(), 'aistudio-hist-docs')); // 历史媒体落这里，不污染真实目录
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (name, cond, detail) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail))); if (!cond) failures++; };
app.whenReady().then(async () => {
    // 模拟 main.js 的 history:save-bytes（写到 tmp documents 目录）
    const docs = path.join(os.tmpdir(), 'aistudio-hist-docs');
    ipcMain.handle('history:save-bytes', async (e, { bytes, folder, filename }) => {
        try {
            const dir = path.join(docs, 'AI Studio', 'history', 'shared', folder || '默认');
            fs.mkdirSync(dir, { recursive: true });
            const localPath = path.join(dir, String(filename || 'f'));
            await fs.promises.writeFile(localPath, Buffer.from(bytes));
            return { ok: true, path: localPath, fileUrl: 'file://' + localPath };
        } catch (err) { return { ok: false, error: err.message }; }
    });
    const win = new BrowserWindow({ width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);
    // 1) base64 图片结果 → 自动落盘 + 历史条目为 file:// 路径
    await win.webContents.executeJavaScript(`CanvasModule._saveResultToHistory('image', 'data:image/png;base64,AAAA', '测试图片', 'test-model')`);
    await sleep(1500);
    const r1 = await win.webContents.executeJavaScript(`(() => {
        const list = JSON.parse(localStorage.getItem('opc_history') || '[]');
        return { count: list.length, first: list[0] || {} };
    })()`);
    assert('hist.entryAdded', r1.count === 1, r1);
    assert('hist.fileUrl', /^file:\/\//.test(r1.first.url || ''), r1.first.url);
    assert('hist.sourceCanvas', r1.first.source === 'canvas', r1.first.source);
    const imgPath = r1.first.url.replace('file://', '');
    assert('hist.fileExists', fs.existsSync(imgPath), imgPath);
    assert('hist.fileContent', fs.readFileSync(imgPath).toString() === 'AAAA-content-or-bin' || fs.readFileSync(imgPath).length === 3, fs.statSync(imgPath).size);
    // 2) 历史面板渲染
    const r2 = await win.webContents.executeJavaScript(`(() => {
        document.getElementById('canvasHistoryHandle').click();
        const list = document.getElementById('canvasHistoryList');
        return { panelOpen: !document.getElementById('canvasHistoryPanel').classList.contains('hidden'),
                 items: list.querySelectorAll('.canvas-history-item').length };
    })()`);
    assert('hist.panelOpens', r2.panelOpen === true, r2);
    assert('hist.panelRenders', r2.items === 1, r2);
    // 3) 空白点击清除选中与小标高亮（pan 未移动路径）
    const r3 = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        await CM._createProject('t');
        const n1 = CM.addNode('image', 100, 100);
        const n2 = CM.addNode('image', 400, 100);
        CM._connect(n1.id, n2.id);
        CM._setRefPick({ nodeId: n2.id, srcId: n1.id });
        // 模拟空白 mousedown → pan（未移动）→ mouseup
        const vp = document.getElementById('canvasViewport');
        vp.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 500, clientY: 500 }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 500 }));
        return {
            selectionCleared: CM.selection.size === 0,
            refPickCleared: !CM._refPick,
            edgeHl: !!document.querySelector('.canvas-edge.edge-ref-hl'),
            labelActive: !!document.querySelector('.cnode-ref-label.active'),
        };
    })()`);
    assert('blank.selectionCleared', r3.selectionCleared === true, r3);
    assert('blank.refPickCleared', r3.refPickCleared === true, r3);
    assert('blank.edgeHlGone', r3.edgeHl === false, r3);
    assert('blank.labelActiveGone', r3.labelActive === false, r3);
    // 4) Ctrl 多选后整体移动
    const r4 = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        CM._renderHistoryPanel && CM._renderHistoryPanel();
        const sel = () => Array.from(CM.selection);
        const n1 = CM.nodes.find(n => n.type === 'image');
        // 直接模拟节点 mousedown（additive）路径的行为序列：
        const els = CM._nodesLayer.querySelectorAll('.cnode');
        const [e1, e2] = els;
        e1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
        e2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true, clientX: 20, clientY: 20 }));
        const afterSel = sel();
        // Ctrl 按住已选中的 e2 再拖 50px：应保持整组多选并整体移动
        const xsBefore = CM.nodes.filter(n => n.type === 'image').map(n => ({ id: n.id, x: n.x }));
        e2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true, clientX: 20, clientY: 20 }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 70, clientY: 20 }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 70, clientY: 20 }));
        const xsAfter = CM.nodes.filter(n => n.type === 'image').map(n => ({ id: n.id, x: n.x }));
        return {
            afterSel,
            bothMoved: xsAfter.every(a => a.x === xsBefore.find(b => b.id === a.id).x + 50),
        };
    })()`);
    assert('ctrl.multiSelect', r4.afterSel.length === 2, r4);
    assert('ctrl.groupMove', r4.bothMoved === true, r4);
    console.log(failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures);
    app.exit(failures === 0 ? 0 : 1);
}).catch(e => { console.log('ERROR ' + (e && e.message)); app.exit(1); });
