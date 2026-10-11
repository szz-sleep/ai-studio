// 彩色连线（生成中/完成态）真实输入测试：能否选中、右键删除、选中视觉反馈
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-edge-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(name, cond, extra) {
    if (cond) console.log(`PASS ${name}`);
    else { failures++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
// 看门狗：任何 executeJavaScript 异常导致主流程卡住时强制退出
setTimeout(() => { fs.writeFileSync(path.join(__dirname, 'edge.result.txt'), 'TIMEOUT'); app.exit(2); }, 60000);

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
        return true;
    })()`);
    await sleep(1500);

    // 三条连线：普通线 / 完成态彩色线 / 生成中蚂蚁线（_connect 无返回值，事后按顺序取 id）
    const ids = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        // 普通：image(无状态) → video(idle)
        const a1 = CM.addNode('image', 150, 200, { url: 'https://e.com/a.png', name: 'A' });
        const v1 = CM.addNode('video', 550, 200, { status: 'idle', model: 'doubao-seedance-v4' });
        CM._connect(a1.id, v1.id);
        // 完成态彩色：image(done) → video(done)
        const a2 = CM.addNode('image', 150, 450, { url: 'https://e.com/b.png', name: 'B', done: true });
        const v2 = CM.addNode('video', 550, 450, { status: 'done', videoUrl: 'https://e.com/v.mp4', model: 'doubao-seedance-v4' });
        CM._connect(a2.id, v2.id);
        // 生成中蚂蚁线：video(generating)
        const a3 = CM.addNode('image', 150, 700, { url: 'https://e.com/c.png', name: 'C' });
        const v3 = CM.addNode('video', 550, 700, { status: 'generating', model: 'doubao-seedance-v4' });
        CM._connect(a3.id, v3.id);
        CM.renderEdges();
        // 视口复位到 1:1
        CM.viewport = { x: 0, y: 0, k: 1 };
        if (typeof CM._applyViewport === 'function') CM._applyViewport();
        const es = CM.edges;
        return { e1: es[es.length - 3].id, e2: es[es.length - 2].id, e3: es[es.length - 1].id, n: es.length };
    })()`);
    assert('S0.edgesCreated', ids.n === 3, ids);
    await sleep(400);

    // —— S0b：生成中节点出线不出蚂蚁线；有旧成片时保持原彩色线 ——
    // 场景1：v3(生成中,无旧成片) → v4：出线应为普通样式
    // 场景2：v5(生成中,保留旧成片videoUrl) → v4：出线应保持 edge-done-video 彩色
    // 入线 a3→v3：应为蚂蚁线
    const animCls = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const v4 = CM.addNode('video', 950, 700, { status: 'idle', model: 'doubao-seedance-v4' });
        const v5 = CM.addNode('video', 950, 950, { status: 'generating', videoUrl: 'https://e.com/old.mp4', model: 'doubao-seedance-v4' });
        const v3 = CM.nodes.find(n => n.type === 'video' && n.data.status === 'generating' && !n.data.videoUrl);
        CM._connect(v3.id, v4.id);
        CM._connect(v5.id, v4.id);
        CM.renderEdges();
        const clsOf = (eid) => {
            const e = CM.edges.find(x => x.id === eid);
            const p1 = CM._portPos(e.from, 'out'), p2 = CM._portPos(e.to, 'in');
            // 通过端点匹配找出对应可视路径
            const paths = Array.from(document.querySelectorAll('.canvas-edge:not(.canvas-edge-hit)'));
            const target = paths.find(p => {
                const g = CM._edgePath(p1.x, p1.y, p2.x, p2.y);
                return p.getAttribute('d') === g;
            });
            return target ? target.getAttribute('class') : null;
        };
        return {
            v3out: clsOf(CM.edges[CM.edges.length - 2].id),
            v5out: clsOf(CM.edges[CM.edges.length - 1].id),
            inToGen: clsOf(CM.edges.find(e => e.to === v3.id).id),
        };
    })()`);
    assert('S0b.outgoingNoOldResultPlain', animCls.v3out !== null && !animCls.v3out.includes('edge-anim') && !animCls.v3out.includes('edge-done'), animCls);
    assert('S0b.outgoingWithOldResultKeptColor', animCls.v5out !== null && animCls.v5out.includes('edge-done-video') && !animCls.v5out.includes('edge-anim'), animCls);
    assert('S0b.incomingEdgeToGeneratingHasAnim', animCls.inToGen !== null && animCls.inToGen.includes('edge-anim-video'), animCls);
    // 出线的几何位置必须稳定：端口锚定标题栏后，节点高度变化不牵动端口 y（用生成展开场景验证）
    const portY = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const v4 = CM.nodes.find(n => n.type === 'video' && n.data.status === 'idle' && CM.edges.some(e => e.to === n.id || e.from === n.id));
        const before = CM._portPos(v4.id, 'in');
        // 模拟生成时选项面板展开：节点被撑高
        const el = CM._nodesLayer.querySelector('.cnode[data-id="' + v4.id + '"]');
        el.style.height = '500px';
        const after = CM._portPos(v4.id, 'in');
        el.style.height = '';
        return { before: before.y, after: after.y };
    })()`);
    assert('S0b.portYStableWhenNodeGrows', portY.before === portY.after, portY);

    // 计算每条线中点的屏幕坐标（三阶贝塞尔 t=0.5：(P0+3P1+3P2+P3)/8）
    const pts = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const rect = CM._viewport.getBoundingClientRect();
        const mid = (eid) => {
            const edge = CM.edges.find(e => e.id === '${ids.e1}') && CM.edges.find(e => e.id === eid);
            const p1 = CM._portPos(edge.from, 'out'), p2 = CM._portPos(edge.to, 'in');
            const dx = Math.max(40, Math.min(200, Math.abs(p2.x - p1.x) * 0.5));
            const c1 = { x: p1.x + dx, y: p1.y }, c2 = { x: p2.x - dx, y: p2.y };
            const wx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8;
            const wy = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
            return { x: Math.round(rect.left + CM.viewport.x + wx * CM.viewport.k), y: Math.round(rect.top + CM.viewport.y + wy * CM.viewport.k) };
        };
        return { m1: mid('${ids.e1}'), m2: mid('${ids.e2}'), m3: mid('${ids.e3}') };
    })()`);

    const realClick = async (pt, button = 'left', cc = 1) => {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button, clickCount: cc });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button, clickCount: cc });
        await sleep(150);
    };

    // —— S1：普通线左键选中（基线）——
    await realClick(pts.m1);
    let s = await win.webContents.executeJavaScript(`({ sel: CanvasModule.selectedEdge, cls: (document.querySelector('.canvas-edge.selected') || {}).getAttribute?.('class') || null })`);
    assert('S1.plainEdgeSelectable', s.sel === ids.e1, s);

    // —— S2：完成态彩色线左键选中 ——
    await realClick(pts.m2);
    s = await win.webContents.executeJavaScript(`(() => {
        const sel = CanvasModule.selectedEdge;
        const vis = document.querySelector('.canvas-edge.selected');
        return { sel, found: !!vis, stroke: vis ? getComputedStyle(vis).stroke : null };
    })()`);
    assert('S2.doneEdgeSelectedInState', s.sel === ids.e2, s);
    // 选中色必须可见（蓝），而不是被 edge-done-* 状态色覆盖
    assert('S2.doneEdgeVisuallyDistinct', s.sel === ids.e2 && s.stroke && s.stroke.includes('59, 130, 246'), s);

    // —— S3：生成中蚂蚁线左键选中（先诊断实际命中情况）——
    const diag = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const hits = Array.from(document.querySelectorAll('.canvas-edge-hit')).map(p => p.getAttribute('d'));
        const vis = Array.from(document.querySelectorAll('.canvas-edge')).map(p => p.getAttribute('class'));
        const e3 = CM.edges.find(e => e.id === '${ids.e3}');
        const p1 = e3 ? CM._portPos(e3.from, 'out') : null;
        const p2 = e3 ? CM._portPos(e3.to, 'in') : null;
        const el = document.elementFromPoint(${pts.m3.x}, ${pts.m3.y});
        return { hitCount: hits.length, e3exists: !!e3, p1, p2, vis,
            atM3: el ? (el.getAttribute('class') || el.tagName) : null };
    })()`);
    console.log('DIAG ' + JSON.stringify(diag));
    await realClick(pts.m3);
    s = await win.webContents.executeJavaScript(`CanvasModule.selectedEdge`);
    assert('S3.animEdgeSelectable', s === ids.e3, s);

    // —— S4：彩色线右键 → 菜单 → 删除连线 ——
    await realClick(pts.m2, 'right');
    let menu = await win.webContents.executeJavaScript(`(() => {
        const m = document.getElementById('canvasContextMenu');
        if (!m || m.classList.contains('hidden')) return null;
        const item = Array.from(m.querySelectorAll('.canvas-menu-item')).find(b => b.textContent.includes('删除连线'));
        if (!item) return { menuItems: Array.from(m.querySelectorAll('.canvas-menu-item')).map(b => b.textContent) };
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    assert('S4.ctxMenuOnColoredEdge', !!menu && !!menu.x, menu);
    if (menu && menu.x) {
        await realClick(menu);
        s = await win.webContents.executeJavaScript(`({
            gone: !CanvasModule.edges.find(e => e.id === '${ids.e2}'),
            count: CanvasModule.edges.length,
        })`);
        assert('S4.coloredEdgeDeleted', s.gone === true, s);
    }

    // —— S5：生成中线右键删除 ——
    await realClick(pts.m3, 'right');
    menu = await win.webContents.executeJavaScript(`(() => {
        const m = document.getElementById('canvasContextMenu');
        if (!m || m.classList.contains('hidden')) return null;
        const item = Array.from(m.querySelectorAll('.canvas-menu-item')).find(b => b.textContent.includes('删除连线'));
        if (!item) return { menuItems: Array.from(m.querySelectorAll('.canvas-menu-item')).map(b => b.textContent) };
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    assert('S5.ctxMenuOnAnimEdge', !!menu && !!menu.x, menu);
    if (menu && menu.x) {
        await realClick(menu);
        s = await win.webContents.executeJavaScript(`!CanvasModule.edges.find(e => e.id === '${ids.e3}')`);
        assert('S5.animEdgeDeleted', s === true, s);
    }

    console.log(`RESULT ${failures === 0 ? 'ALL-PASS' : failures + '-FAILED'}`);
    fs.writeFileSync(path.join(__dirname, 'edge.result.txt'),
        (failures === 0 ? 'ALL PASS' : failures + ' FAILED') + `\n${JSON.stringify({ ids, pts }, null, 2)}`);
    setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
})();
