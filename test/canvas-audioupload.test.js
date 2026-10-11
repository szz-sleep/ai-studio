// 画布音频节点上传链路诊断测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-audioupload-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(name, cond, extra) {
    if (cond) console.log(`PASS ${name}`);
    else { failures++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
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
        return true;
    })()`);
    await sleep(1500);

    // —— 诊断1：双击空音频节点是否触发 _pickLocalAudio ——
    const rDbl = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const n = CM.addNode('audio', 300, 200);
        await new Promise(r => setTimeout(r, 250));
        const el = document.querySelector('.cnode[data-id="' + n.id + '"]');
        if (!el) return { err: 'node element not found' };
        let called = 0, inputClicks = 0, inputCreated = 0;
        const origPick = CM._pickLocalAudio.bind(CM);
        CM._pickLocalAudio = (node) => { called++; return origPick(node); };
        const origClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () { inputClicks++; inputCreated++; };
        try {
            const wrap = el.querySelector('.cnode-audio-wrap');
            const targetInfo = { hasWrap: !!wrap, tag: el.querySelector('.cnode-body') ? 'body-exists' : 'no-body' };
            // 模拟真实双击：两次 mousedown+mouseup+click，再 dblclick
            const opts = { bubbles: true, cancelable: true, clientX: 350, clientY: 250 };
            wrap.dispatchEvent(new MouseEvent('mousedown', opts));
            window.dispatchEvent(new MouseEvent('mouseup', opts));
            wrap.dispatchEvent(new MouseEvent('click', opts));
            wrap.dispatchEvent(new MouseEvent('mousedown', opts));
            window.dispatchEvent(new MouseEvent('mouseup', opts));
            wrap.dispatchEvent(new MouseEvent('click', opts));
            wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 350, clientY: 250 }));
            return { called, inputClicks, targetInfo };
        } finally {
            HTMLInputElement.prototype.click = origClick;
        }
    })()`);
    assert('D.dblclickTriggersPick', rDbl.called === 1, rDbl);
    assert('D.fileInputClickInvoked', rDbl.inputClicks === 1, rDbl);

    // —— 诊断2：右键菜单「重新选择音频」是否触发 ——
    const rCtx = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const n = CM.addNode('audio', 500, 200, { url: 'data:audio/mp3;base64,AAAA', name: 'demo.mp3' });
        await new Promise(r => setTimeout(r, 250));
        const el = document.querySelector('.cnode[data-id="' + n.id + '"]');
        let called = 0;
        const origPick = CM._pickLocalAudio.bind(CM);
        CM._pickLocalAudio = (node) => { called++; return origPick(node); };
        // 打开右键菜单
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 550, clientY: 250 }));
        await new Promise(r => setTimeout(r, 200));
        const menu = document.querySelector('.ctx-menu, .context-menu, [class*="context"]');
        const items = menu ? Array.from(menu.querySelectorAll('button, .menu-item, [class*="item"]')).map(b => b.textContent.trim()) : [];
        const reItem = menu ? Array.from(menu.querySelectorAll('button, .menu-item, [class*="item"]')).find(b => b.textContent.includes('重新选择音频')) : null;
        if (reItem) reItem.click();
        await new Promise(r => setTimeout(r, 200));
        // 关闭菜单
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return { menuFound: !!menu, itemCount: items.length, items: items.slice(0, 8), hasReItem: !!reItem, called };
    })()`);
    assert('E.menuOpens', rCtx.menuFound, rCtx);
    assert('E.hasReAudioItem', rCtx.hasReItem, rCtx.items);
    assert('E.menuItemTriggersPick', rCtx.called === 1, rCtx);

    // —— 诊断3：_setAudioFromFile 真实替换音频（换音频能力） ——
    const rSet = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const n = CM.getNode(document.querySelector('.cnode') ? undefined : undefined) || CM.addNode('audio', 700, 200, { url: 'data:audio/mp3;base64,OLDDATA', name: 'old.mp3' });
        await new Promise(r => setTimeout(r, 150));
        const fakeFile = { type: 'audio/mpeg', name: 'new-song.mp3' };
        const origB64 = API.fileToBase64 ? API.fileToBase64.bind(API) : null;
        API.fileToBase64 = async (f) => 'data:audio/mp3;base64,NEWDATA';
        try {
            await CM._setAudioFromFile(n, fakeFile);
        } finally {
            if (origB64) API.fileToBase64 = origB64;
        }
        await new Promise(r => setTimeout(r, 150));
        const el = document.querySelector('.cnode[data-id="' + n.id + '"]');
        const player = el ? el.querySelector('.cnode-audio-player') : null;
        const wrapEmpty = el ? el.querySelector('.cnode-audio-wrap')?.classList.contains('empty') : null;
        return {
            url: n.data.url, name: n.data.name,
            playerShown: player && player.style.display !== 'none',
            playerSrc: player ? (player.src || '').substring(0, 40) : null,
            wrapEmpty,
        };
    })()`);
    assert('F.urlReplaced', rSet.url === 'data:audio/mp3;base64,NEWDATA', rSet);
    assert('F.nameReplaced', rSet.name === 'new-song.mp3', rSet);
    assert('F.playerVisibleAfterReplace', rSet.playerShown === true, rSet);

    console.log(`RESULT ${failures === 0 ? 'ALL-PASS' : failures + '-FAILED'}`);
    fs.writeFileSync(path.join(__dirname, 'audioupload.result.txt'),
        (failures === 0 ? 'ALL PASS' : failures + ' FAILED') + '\n' + JSON.stringify({ rDbl, rCtx, rSet }, null, 2));
    setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
})();
