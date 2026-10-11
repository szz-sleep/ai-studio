// 画布：撤销/重做（后退/前进）测试 —— 各 5 步上限、拖动与对齐可撤销、去重
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-undo-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const lines = [];
function assert(name, cond, extra) {
    if (cond) console.log(`PASS ${name}`);
    else { failures++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
    lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
}

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
        localStorage.removeItem('aistudio_canvas_settings');
        return true;
    })()`);
    await sleep(1500);

    // ============ 1. 基础撤销/重做 + 5 步上限 + 去重 ============
    const rBase = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        CM.clearAll && CM.nodes.length && (CM.nodes = [], CM.edges = [], CM.renderAll());
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        // 连续添加 8 个节点 → 撤销栈只保留最后 5 步
        const ids = [];
        for (let i = 0; i < 8; i++) ids.push(CM.addNode('text', 100 + i * 40, 100 + i * 40).id);
        r.undoCapped = CM._undoStack.length;
        r.nodeCount = CM.nodes.length;
        // 撤销 5 次 → 回到只剩前 3 个节点
        for (let i = 0; i < 5; i++) CM.undo();
        r.after5Undo = CM.nodes.length;
        r.undoEmptyAfter5 = CM._undoStack.length === 0;
        // 再撤销无效（栈空），节点数不变
        CM.undo();
        r.stillAfter5 = CM.nodes.length;
        // 重做 5 次 → 恢复全部 8 个
        for (let i = 0; i < 5; i++) CM.redo();
        r.after5Redo = CM.nodes.length;
        // 重做栈上限：撤销 3 步后连续重做/撤销再压入 → 重做栈不超过 5
        for (let i = 0; i < 5; i++) CM.undo();
        r.redoLen = CM._redoStack.length;
        // 去重：状态未变时连续 _pushHistory 不产生无效步
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        CM._pushHistory(); CM._pushHistory(); CM._pushHistory();
        r.dedupe = CM._undoStack.length;
        // 工具栏按钮点击触发 undo/redo
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        CM.addNode('text', 50, 50);
        const n1 = CM.nodes.length;
        document.getElementById('canvasUndoBtn').click();
        r.btnUndo = CM.nodes.length === n1 - 1;
        document.getElementById('canvasRedoBtn').click();
        r.btnRedo = CM.nodes.length === n1;
        return r;
    })()`);
    assert('undo.cap5', rBase.undoCapped === 5, rBase.undoCapped);
    assert('undo.eightNodes', rBase.nodeCount === 8, rBase.nodeCount);
    assert('undo.after5UndoKeeps3', rBase.after5Undo === 3, rBase.after5Undo);
    assert('undo.stackEmpty', rBase.undoEmptyAfter5, rBase.undoEmptyAfter5);
    assert('undo.noopWhenEmpty', rBase.stillAfter5 === 3, rBase.stillAfter5);
    assert('undo.after5RedoRestores8', rBase.after5Redo === 8, rBase.after5Redo);
    assert('undo.redoCap5', rBase.redoLen === 5, rBase.redoLen);
    assert('undo.dedupeIdentical', rBase.dedupe === 1, rBase.dedupe);
    assert('undo.toolbarUndoBtn', rBase.btnUndo, rBase.btnUndo);
    assert('undo.toolbarRedoBtn', rBase.btnRedo, rBase.btnRedo);

    // ============ 2. 拖动节点可撤销 ============
    const rDrag = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        CM.nodes = []; CM.edges = []; CM.renderAll();
        const n = CM.addNode('text', 400, 300);
        CM._undoStack.length = 0; // 只测拖动这一步
        const el = document.querySelector('.cnode[data-id="' + n.id + '"]');
        const rect = el.getBoundingClientRect();
        const sx = rect.left + 10, sy = rect.top + 5;
        const toWorld = (cx, cy) => {
            const vp = document.getElementById('canvasViewport').getBoundingClientRect();
            return { x: (cx - vp.left - CM.viewport.x) / CM.viewport.k, y: (cy - vp.top - CM.viewport.y) / CM.viewport.k };
        };
        // 真实序列：节点 mousedown → window mousemove(>1px) → window mouseup
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy }));
        const w1 = toWorld(sx, sy);
        for (let i = 1; i <= 5; i++) {
            const cx = sx + i * 10, cy = sy + i * 8;
            const w = toWorld(cx, cy);
            CM.viewport.k = 1; CM.viewport.x = 0; CM.viewport.y = 0; // 简化坐标换算
            window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
        }
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 50, clientY: sy + 40 }));
        // addNode 以中心点定位，拖动前左缘坐标 = 400 - w/2, 300 - 40（h 初始为 0+渲染后真实高度，直接记录实测值）
        const origin = { x: JSON.parse(CM._undoStack[0]).nodes.find(x => x.id === n.id).x,
                         y: JSON.parse(CM._undoStack[0]).nodes.find(x => x.id === n.id).y };
        r.moved = CM.getNode(n.id).x !== origin.x || CM.getNode(n.id).y !== origin.y;
        r.historyPushed = CM._undoStack.length >= 1;
        r.pushedIsPreDrag = CM._undoStack.length === 1;
        CM.undo();
        const n2 = CM.getNode(n.id); // undo/redo 重建节点对象，必须重新获取
        r.undoRestoresOrigin = n2.x === origin.x && n2.y === origin.y;
        CM.redo();
        const n3 = CM.getNode(n.id);
        r.redoReappliesMove = n3.x !== origin.x || n3.y !== origin.y;
        r.dbg = { origin, afterDrag: { x: CM.getNode(n.id).x, y: CM.getNode(n.id).y } };
        return r;
    })()`);
    assert('drag.nodeMoved', rDrag.moved, rDrag.dbg);
    assert('drag.historyPushed', rDrag.historyPushed, rDrag.historyPushed);
    assert('drag.pushedIsPreDrag', rDrag.pushedIsPreDrag, rDrag.pushedIsPreDrag);
    assert('drag.undoRestoresOrigin', rDrag.undoRestoresOrigin, rDrag.undoRestoresOrigin);
    assert('drag.redoReapplies', rDrag.redoReappliesMove, rDrag.redoReappliesMove);

    // ============ 3. 对齐操作可撤销（先压栈后改坐标） ============
    const rAlign = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        CM._undoStack.length = 0; CM._redoStack.length = 0;
        CM.nodes = []; CM.edges = []; CM.renderAll();
        const a = CM.addNode('text', 100, 500);
        const b = CM.addNode('text', 400, 200);
        CM._undoStack.length = 0;
        const before = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
        CM.selection = new Set([a.id, b.id]);
        CM._renderSelection();
        CM._alignSelected('left');
        const aA = CM.getNode(a.id), bA = CM.getNode(b.id);
        r.changed = aA.x !== before.a.x || bA.x !== before.b.x;
        r.aligned = aA.x === bA.x;
        r.dbg = { before, afterA: { x: aA.x, y: aA.y }, afterB: { x: bA.x, y: bA.y } };
        r.snapshotIsPreAlign = CM._undoStack.length === 1 &&
            JSON.parse(CM._undoStack[0]).nodes.find(x => x.id === a.id).x === before.a.x;
        CM.undo();
        const a2 = CM.getNode(a.id), b2 = CM.getNode(b.id); // undo/redo 重建对象，重新获取
        r.undoRestores = a2.x === before.a.x && b2.x === before.b.x && b2.y === before.b.y;
        CM.redo();
        const a3 = CM.getNode(a.id), b3 = CM.getNode(b.id);
        r.redoRealigns = a3.x === b3.x;
        return r;
    })()`);
    assert('align.positionChanged', rAlign.changed, rAlign.dbg);
    assert('align.leftAligned', rAlign.aligned, rAlign.dbg);
    assert('align.snapshotIsPreAlign', rAlign.snapshotIsPreAlign, rAlign.snapshotIsPreAlign);
    assert('align.undoRestores', rAlign.undoRestores, rAlign.undoRestores);
    assert('align.redoRealigns', rAlign.redoRealigns, rAlign.redoRealigns);

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'undo.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'undo.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
