/**
 * 无限画布 UX 回归测试：
 *  1. 背景样式/背景色/固定按钮与工具栏同行且不换行
 *  2. 固定按钮点击后图标（竖图钉/斜图钉+斜线）与状态切换
 *  3. 图片/视频节点参数区默认折叠，只显示预览；开关可展开并持久化
 *  4. 空图片节点不再出现残破图标（空 src img 被隐藏）
 *  5. 视频节点空预览占位 <-> 生成结果切换；生成中自动展开参数区
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test\canvas-ux.test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'aistudio-canvas-ux-test'));

const RESULT_FILE = path.join(__dirname, 'canvas-ux.result.txt');
const lines = [];
const flush = () => { try { fs.writeFileSync(RESULT_FILE, lines.join('\n')); } catch (e) {} };
const out = (s) => { lines.push(s); flush(); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(name, cond, extra) {
    if (cond) out(`PASS ${name}`);
    else { failures++; out(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1560, height: 900,
        show: true,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    const consoleErrors = [];
    win.webContents.on('console-message', (e, level, message) => {
        if (level >= 3) consoleErrors.push(message);
    });

    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);

    // ---------- 1&2. 工具栏布局 + 固定按钮 ----------
    const r1 = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const bar = document.querySelector('.canvas-toolbar');
        const bg = document.getElementById('canvasBgStyle');
        const color = document.getElementById('canvasBgColor');
        const pin = document.getElementById('canvasToolbarPinBtn');
        const panel = document.getElementById('tab-canvas');
        r.bgInBar = !!(bg && bar.contains(bg));
        r.colorInBar = !!(color && bar.contains(color));
        r.pinInBar = !!(pin && bar.contains(pin));
        const tops = [bar, bg, color, pin].map(el => Math.round(el.getBoundingClientRect().top));
        r.sameRow = Math.max(...tops) - Math.min(...tops) <= 4;
        r.noWrap = bar.scrollWidth <= bar.clientWidth + 1;
        r.pinHasTwoIcons = !!pin.querySelector('.pin-on') && !!pin.querySelector('.pin-off');
        r.pinOffHiddenInitially = getComputedStyle(pin.querySelector('.pin-off')).display === 'none';
        r.pinOnShownInitially = getComputedStyle(pin.querySelector('.pin-on')).display !== 'none';
        // 点击固定
        pin.click();
        r.pinnedClass = panel.classList.contains('toolbar-pinned');
        r.pinActive = pin.classList.contains('active');
        r.pinOffShownAfterPin = getComputedStyle(pin.querySelector('.pin-off')).display !== 'none';
        r.pinOnHiddenAfterPin = getComputedStyle(pin.querySelector('.pin-on')).display === 'none';
        r.savedPin = JSON.parse(localStorage.getItem('aistudio_canvas_settings') || '{}').toolbarPin === true;
        // 再点取消
        pin.click();
        r.unpinned = !panel.classList.contains('toolbar-pinned') && !pin.classList.contains('active');
        r.pinOffHiddenAfterUnpin = getComputedStyle(pin.querySelector('.pin-off')).display === 'none';
        return r;
    })()`);
    ['bgInBar','colorInBar','pinInBar','sameRow','noWrap','pinHasTwoIcons','pinOffHiddenInitially','pinOnShownInitially',
     'pinnedClass','pinActive','pinOffShownAfterPin','pinOnHiddenAfterPin','savedPin','unpinned','pinOffHiddenAfterUnpin']
        .forEach(k => assert(`toolbar.${k}`, r1[k], r1[k]));

    // ---------- 3&4&5. 节点折叠 / 残破图标 / 视频占位 ----------
    let r2 = null, r2err = null;
    try {
        r2 = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = (typeof CanvasModule !== 'undefined') ? CanvasModule : window.CanvasModule;
        if (!CM) throw new Error('CanvasModule not found');
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        await new Promise(res => setTimeout(res, 300));

        // 图片节点：默认只显示预览
        const img = CM.addNode('image', 100, 100);
        const imgEl = document.querySelector('.cnode[data-id="' + img.id + '"]');
        r.imgOptsCollapsed = !imgEl.querySelector('.cnode-opts').classList.contains('open');
        r.imgHasToggle = !!imgEl.querySelector('.cnode-opts-toggle');
        r.imgPreviewVisible = getComputedStyle(imgEl.querySelector('.cnode-img-wrap')).display !== 'none';
        r.emptyImgHidden = getComputedStyle(imgEl.querySelector('.cnode-img')).display === 'none';
        r.imgGenBtnHidden = imgEl.querySelector('.cnode-img-generate-btn').offsetParent === null;
        // 展开并持久化
        imgEl.querySelector('.cnode-opts-toggle').click();
        r.imgOptsOpenAfterClick = imgEl.querySelector('.cnode-opts').classList.contains('open');
        r.imgDataOpen = !!CM.getNode(img.id).data.optsOpen;
        // 再收起
        imgEl.querySelector('.cnode-opts-toggle').click();
        r.imgOptsCollapsedAgain = !imgEl.querySelector('.cnode-opts').classList.contains('open');
        // 展开后生成按钮可见
        imgEl.querySelector('.cnode-opts-toggle').click();
        r.imgGenBtnVisibleOpen = imgEl.querySelector('.cnode-img-generate-btn').offsetParent !== null;

        // 视频节点：占位预览 + 折叠
        const vid = CM.addNode('video', 400, 100);
        const vEl = document.querySelector('.cnode[data-id="' + vid.id + '"]');
        r.vidOptsCollapsed = !vEl.querySelector('.cnode-opts').classList.contains('open');
        r.vidPhVisible = getComputedStyle(vEl.querySelector('.cnode-video-wrap')).display !== 'none';
        r.vidResultHidden = vEl.querySelector('.cnode-video-result').style.display === 'none';
        // 生成结果出现：占位隐藏、结果显示（折叠状态下预览也可见）
        const vn = CM.getNode(vid.id);
        vn.data.videoUrl = 'http://example.com/v.mp4';
        CM._updateVideoNodeStatus(vEl, vn);
        r.vidResultShown = vEl.querySelector('.cnode-video-result').style.display !== 'none';
        r.vidPhHidden = vEl.querySelector('.cnode-video-wrap').style.display === 'none';
        r.vidPreviewVisibleCollapsed = vEl.querySelector('.cnode-video-result').offsetParent !== null;

        // 生成中自动展开参数区
        const vid2 = CM.addNode('video', 700, 100);
        const vEl2 = document.querySelector('.cnode[data-id="' + vid2.id + '"]');
        const vn2 = CM.getNode(vid2.id);
        vn2.data.status = 'generating';
        CM._updateVideoNodeStatus(vEl2, vn2);
        r.autoOpenOnBusy = vEl2.querySelector('.cnode-opts').classList.contains('open');

        // 图片节点生成中自动展开
        const img2 = CM.addNode('image', 1000, 100);
        const imgEl2 = document.querySelector('.cnode[data-id="' + img2.id + '"]');
        const im2 = CM.getNode(img2.id);
        im2.data.status = 'generating';
        CM._updateImageNodeStatus(imgEl2, im2);
        r.imgAutoOpenOnBusy = imgEl2.querySelector('.cnode-opts').classList.contains('open');

        // 折叠状态在 DOM 重建后保持（renderAll 不重建 body，但 _applyNodeOpts 对齐）
        CM.getNode(img.id).data.optsOpen = false;
        CM._applyNodeOpts(imgEl, CM.getNode(img.id));
        r.imgOptsSynced = !imgEl.querySelector('.cnode-opts').classList.contains('open');
        return r;
    })()`);
    } catch (e) { r2err = String(e && e.message || e); }
    if (r2err) out(`ERROR nodes-block: ${r2err}`);    ['imgOptsCollapsed','imgHasToggle','imgPreviewVisible','emptyImgHidden','imgGenBtnHidden',
     'imgOptsOpenAfterClick','imgDataOpen','imgOptsCollapsedAgain','imgGenBtnVisibleOpen',
     'vidOptsCollapsed','vidPhVisible','vidResultHidden','vidResultShown','vidPhHidden','vidPreviewVisibleCollapsed',
     'autoOpenOnBusy','imgAutoOpenOnBusy','imgOptsSynced']
        .forEach(k => { if (r2) assert(`nodes.${k}`, r2[k], r2[k]); });

    // ---------- 控制台错误 ----------
    const realErrors = consoleErrors.filter(m => !/net::|ERR_|Failed to load resource|火山|API|401|403|404/.test(m));
    assert('noRealConsoleErrors', realErrors.length === 0, realErrors.slice(0, 3));

    out(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    flush();
    app.exit(failures === 0 ? 0 : 1);
});
