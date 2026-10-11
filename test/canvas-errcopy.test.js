// 画布错误信息可复制测试
// 注意：模型异步加载完成后会触发 renderAll 重建节点 DOM，所有元素检查必须在稳定后重新查询
const { app, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-errcopy-test'));

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

    // 第一步：建立节点与错误状态
    await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        CM.addNode('video', 200, 150, { duration: 5 });
        const v = CM.nodes.find(n => n.type === 'video');
        v.data.status = 'error';
        v.data.error = 'API 请求失败 (500)：{"error":{"message":"duration 30s only supported by MiniMax-H3, got doubao-seedance-v4"}}';
        CM.addNode('image', 520, 150, {});
        const img = CM.nodes.find(n => n.type === 'image');
        img.data.status = 'error';
        img.data.error = '生图失败：内容审核未通过 (OutputImageSensitiveContentDetected)';
        CM.renderAll();
        return CM.nodes.length;
    })()`);

    // 第二步：等待所有异步重渲染（模型加载等）完成，DOM 稳定
    await sleep(2000);

    // 第三步：重新查询并检查
    const r = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const vel = document.querySelector('.cnode-video-status')?.closest('.cnode');
        const vLine = vel?.querySelector('.cnode-status-line.error');
        r.vLineExists = !!vLine;
        r.vTitle = vLine?.title || '';
        r.vConnected = !!vLine?.isConnected;
        r.vText = vLine?.textContent || '';
        r.rendered = !!vLine?.offsetParent; // 非 null = 可见（出错自动展开）
        const iel = document.querySelector('.cnode-img-status')?.closest('.cnode');
        const iLine = iel?.querySelector('.cnode-status-line.error');
        r.iLineExists = !!iLine;
        r.iTitle = iLine?.title || '';
        // CSS：可选中 + 指针光标
        const cs = vLine ? getComputedStyle(vLine) : null;
        r.selectable = !!cs && (cs.userSelect === 'text' || cs.webkitUserSelect === 'text');
        r.cursorPointer = !!cs && cs.cursor === 'pointer';
        r.cssDebug = cs ? { us: cs.userSelect, cur: cs.cursor } : 'no-line';
        return r;
    })()`);

    assert('video.errorLineExists', r.vLineExists, r.vLineExists);
    assert('video.lineConnected', r.vConnected, r.vConnected);
    assert('video.titleHint', r.vTitle === '点击复制完整错误信息', r.vTitle);
    assert('video.errorTextIntact', r.vText.includes('MiniMax-H3'), r.vText);
    assert('video.errorVisibleWhenError', r.rendered === true, r.rendered);
    assert('image.errorLineExists', r.iLineExists, r.iLineExists);
    assert('image.titleHint', r.iTitle === '点击复制完整错误信息', r.iTitle);
    assert('css.selectable', r.selectable, r.cssDebug);
    assert('css.cursorPointer', r.cursorPointer, r.cssDebug);

    // 第四步：真实鼠标点击视频节点的错误行 → 剪贴板应有完整错误
    clipboard.clear();
    const rect = await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cnode-video-status')?.closest('.cnode')?.querySelector('.cnode-status-line.error');
        const rc = line.getBoundingClientRect();
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
    await sleep(700);
    const copied = clipboard.readText();
    assert('click.copiedToClipboard', copied.includes('MiniMax-H3'), copied);

    // 点击后不应进入节点拖拽/框选状态（mousedown 被 stopPropagation）
    const dragState = await win.webContents.executeJavaScript(`(() => {
        const CM = CanvasModule;
        return { dragging: !!CM._dragging, selecting: !!CM._selecting };
    })()`);
    assert('click.noDragStarted', !dragState.dragging && !dragState.selecting, dragState);

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'errcopy.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'errcopy.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
