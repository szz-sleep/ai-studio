// 真实输入事件回归：项目双击重命名/单击切换 + 音频节点双击上传/右键换音频/入库
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-realtap2-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(name, cond, extra) {
    if (cond) console.log(`PASS ${name}`);
    else { failures++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const st1 = { hasInput: false, value: null };

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

    // 准备：两个项目 + 展开项目面板（默认隐藏，隐藏时 getBoundingClientRect 全为 0）
    await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        await CM._createProject('项目甲');
        await CM._createProject('项目乙');
        const panel = document.getElementById('canvasProjectsPanel');
        if (panel) panel.classList.remove('hidden');
        CM._renderProjects();
        return CM._projects().map(p => p.name);
    })()`);
    await sleep(400);

    // —— S1：真实双击「非当前项目」→ 重命名输入框 ——
    const pos1 = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const items = Array.from(document.querySelectorAll('#canvasProjectsList .canvas-project-item'));
        const target = items.find(it => it.dataset.id !== CM.currentProjectId);
        if (!target) return null;
        const r = target.querySelector('.canvas-project-name').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: target.dataset.id };
    })()`);
    assert('S1.targetFound', !!pos1, pos1);
    assert('S1.panelVisible', !!pos1 && (pos1.x > 0 || pos1.y > 0), pos1);
    if (pos1) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: pos1.x, y: pos1.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: pos1.x, y: pos1.y, button: 'left', clickCount: 1 });
        await sleep(120);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: pos1.x, y: pos1.y, button: 'left', clickCount: 2 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: pos1.x, y: pos1.y, button: 'left', clickCount: 2 });
        await sleep(400);
        const r1 = await win.webContents.executeJavaScript(`(() => {
            const inp = document.querySelector('#canvasProjectsList .canvas-project-rename');
            return { hasInput: !!inp, value: inp ? inp.value : null, focused: inp === document.activeElement };
        })()`);
        Object.assign(st1, r1);
        assert('S1.renameInputAppears', r1.hasInput === true, r1);
        if (r1.hasInput) {
            await win.webContents.executeJavaScript(`(() => {
                const inp = document.querySelector('#canvasProjectsList .canvas-project-rename');
                inp.value = '改名成功';
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return true;
            })()`);
            await sleep(300);
            const names = await win.webContents.executeJavaScript(`CanvasModule._projects().map(p => p.name)`);
            assert('S1.renameCommitted', names.includes('改名成功'), names);
        }
        // 取消切换定时器的影响：等待后确认没有发生项目切换
        await sleep(400);
        const curAfter = await win.webContents.executeJavaScript(`CanvasModule.currentProjectId`);
        assert('S1.noAccidentalSwitch', curAfter === (await win.webContents.executeJavaScript(`localStorage.getItem(CanvasModule.PROJECT_CURRENT_KEY)`)) && st1.hasInput, { curAfter });
    }

    // —— S2：真实单击另一个项目 → 280ms 后切换 ——
    const pos2 = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const items = Array.from(document.querySelectorAll('#canvasProjectsList .canvas-project-item'));
        const target = items.find(it => it.dataset.id !== CM.currentProjectId);
        if (!target) return null;
        const r = target.querySelector('.canvas-project-name').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: target.dataset.id };
    })()`);
    if (pos2) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
        await sleep(700);
        const cur = await win.webContents.executeJavaScript(`CanvasModule.currentProjectId`);
        assert('S2.singleClickSwitches', cur === pos2.id, { cur, want: pos2.id });
    }

    // —— S3：真实双击空音频节点 → 触发 _pickLocalAudio（无 preload 回退 input.click）——
    const nid = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const n = CM.addNode('audio', 300, 200);
        return n.id;
    })()`);
    await sleep(300);
    const c3 = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.cnode[data-id="' + '${nid}' + '"] .cnode-audio-wrap');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await win.webContents.executeJavaScript(`(() => {
        window.__pickCalls = 0; window.__inputClicks = 0;
        const CM = CanvasModule;
        const origPick = CM._pickLocalAudio.bind(CM);
        CM._pickLocalAudio = (n) => { window.__pickCalls++; return origPick(n); };
        HTMLInputElement.prototype.click = function () { window.__inputClicks++; };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c3.x, y: c3.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c3.x, y: c3.y, button: 'left', clickCount: 1 });
    await sleep(120);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c3.x, y: c3.y, button: 'left', clickCount: 2 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c3.x, y: c3.y, button: 'left', clickCount: 2 });
    await sleep(400);
    const st3 = await win.webContents.executeJavaScript(`({ pick: window.__pickCalls, clicks: window.__inputClicks })`);
    assert('S3.audioDblclickTriggersPick', st3.pick === 1 && st3.clicks === 1, st3);

    // —— S4：真实右键已加载音频 → 菜单「重新选择音频」→ 触发 pick ——
    await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        const n = CM.getNode('${nid}');
        n.data.url = 'data:audio/mpeg;base64,AAAA';
        n.data.name = 'demo.mp3';
        CM.renderAll();
        return true;
    })()`);
    await sleep(300);
    const c4 = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.cnode[data-id="' + '${nid}' + '"]');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c4.x, y: c4.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c4.x, y: c4.y, button: 'right', clickCount: 1 });
    await sleep(400);
    const itemPos = await win.webContents.executeJavaScript(`(() => {
        const menu = document.getElementById('canvasContextMenu');
        if (!menu || menu.classList.contains('hidden')) return null;
        const items = Array.from(menu.querySelectorAll('.canvas-menu-item'));
        const re = items.find(b => b.textContent.includes('重新选择音频'));
        const sync = items.find(b => b.textContent.includes('同步到素材库'));
        if (!re) return { menuItems: items.map(b => b.textContent) };
        const r = re.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), hasSync: !!sync };
    })()`);
    assert('S4.menuOpenedWithReAudio', !!itemPos && !!itemPos.x, itemPos);
    assert('S4.hasSyncToLibItem', !!itemPos && itemPos.hasSync === true, itemPos);
    if (itemPos && itemPos.x) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: itemPos.x, y: itemPos.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: itemPos.x, y: itemPos.y, button: 'left', clickCount: 1 });
        await sleep(400);
        const st4 = await win.webContents.executeJavaScript(`({ pick: window.__pickCalls, clicks: window.__inputClicks })`);
        assert('S4.rePickTriggersDialog', st4.pick === 2 && st4.clicks === 2, st4);
    }

    // —— S5：音频同步素材库（mock 上传）——
    const st5 = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const n = CM.getNode('${nid}');
        n.data.url = 'data:audio/mpeg;base64,AAAA';
        n.data.assetId = null;
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => { window.__uploadedType = file.type; return 'https://host.example/demo.mp3'; };
        MaterialLib._upsert({ id: 'asset_audio_1', name: 'demo.mp3', url: 'https://host.example/demo.mp3', sourceUrl: 'https://host.example/demo.mp3', type: 'audio', status: 'ready', time: Date.now() });
        try {
            await CM._syncAudioToLib(n);
        } finally {
            MaterialLib.uploadFile = origUpload;
        }
        return { assetId: n.data.assetId, url: n.data.url, uploadedType: window.__uploadedType };
    })()`);
    assert('S5.audioSyncedToLib', st5.assetId === 'asset_audio_1' && st5.url === 'data:audio/mpeg;base64,AAAA' && st5.uploadedType === 'audio/mpeg', st5);

    console.log(`RESULT ${failures === 0 ? 'ALL-PASS' : failures + '-FAILED'}`);
    fs.writeFileSync(path.join(__dirname, 'realtap.result.txt'),
        (failures === 0 ? 'ALL PASS' : failures + ' FAILED') + `\n${JSON.stringify({ pos1, st1, st3, st4: itemPos, st5 }, null, 2)}`);
    setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
})();
