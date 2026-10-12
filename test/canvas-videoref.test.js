// 画布：视频节点上传本机视频 / 素材库选视频 / 参考视频 asset:// / 图片节点下载 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-videoref-test'));

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
        return true;
    })()`);
    await sleep(1500);

    // ============ 1. 节点结构：视频节点占位文案 / 图片节点下载按钮 ============
    const rBase = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 100, 100);
        r.phText = document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-video-placeholder')?.textContent || '';
        r.videoHasPorts = !!document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-port-out')
            && !!document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-port-in');
        const img = CM.addNode('image', 400, 100, { url: 'https://example.com/dl.jpg', name: '照片.png' });
        const dl = document.querySelector('.cnode[data-id="' + img.id + '"] .cnode-act-img-download');
        r.imgDownloadBtn = !!dl;
        r.imgBtnCount = document.querySelectorAll('.cnode[data-id="' + img.id + '"] .cnode-btn-row .cnode-btn').length;
        return r;
    })()`);
    assert('base.videoPlaceholderUploadHint', rBase.phText.includes('双击上传'), rBase.phText);
    assert('base.videoPorts', rBase.videoHasPorts, rBase.videoHasPorts);
    assert('base.imageDownloadBtn', rBase.imgDownloadBtn, rBase.imgDownloadBtn);
    assert('base.imageBtnRow3', rBase.imgBtnCount === 3, rBase.imgBtnCount);

    // ============ 2. 视频节点上传本机视频（_setVideoFromFile） ============
    const rUpload = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        r.fnExists = typeof CM._setVideoFromFile === 'function' && typeof CM._pickLocalVideo === 'function';
        const v = CM.addNode('video', 700, 100);
        const file = new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])], 'myref.mp4', { type: 'video/mp4' });
        await CM._setVideoFromFile(v, file);
        r.videoUrlIsData = typeof v.data.videoUrl === 'string' && v.data.videoUrl.startsWith('data:video/mp4');
        r.nameSet = v.data.name === 'myref.mp4';
        r.statusIdle = v.data.status === 'idle';
        // 预览区应显示 <video> 且带查看/下载按钮
        const el = document.querySelector('.cnode[data-id="' + v.id + '"]');
        r.previewShown = el.querySelector('.cnode-video-result') && el.querySelector('.cnode-video-result').style.display !== 'none';
        r.hasDownload = !!el.querySelector('.cnode-act-download');
        // 非视频文件拒绝
        const v2 = CM.addNode('video', 900, 100);
        await CM._setVideoFromFile(v2, new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
        r.rejectsNonVideo = !v2.data.videoUrl;
        return r;
    })()`);
    assert('up.fnExists', rUpload.fnExists, rUpload.fnExists);
    assert('up.videoUrlIsData', rUpload.videoUrlIsData, rUpload.videoUrlIsData);
    assert('up.nameSet', rUpload.nameSet, rUpload.nameSet);
    assert('up.statusIdle', rUpload.statusIdle, rUpload.statusIdle);
    assert('up.previewShown', rUpload.previewShown, rUpload.previewShown);
    assert('up.hasDownload', rUpload.hasDownload, rUpload.hasDownload);
    assert('up.rejectsNonVideo', rUpload.rejectsNonVideo, rUpload.rejectsNonVideo);

    // ============ 3. 从素材库选择视频（filterType=video，落地 videoUrl+assetId） ============
    const rPick = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        r.fnExists = typeof CM._pickVideoMaterial === 'function';
        const v = CM.addNode('video', 1100, 100);
        const orig = MaterialLib.openPicker.bind(MaterialLib);
        let capturedType = null;
        MaterialLib.openPicker = (cb, type) => {
            capturedType = type;
            cb({ id: 'asset-video-9', url: 'https://cdn.example.com/lib.mp4', name: '库视频.mp4', type: 'video' });
        };
        try { CM._pickVideoMaterial(v); } finally { MaterialLib.openPicker = orig; }
        r.filterVideo = capturedType === 'video';
        r.videoUrlSet = v.data.videoUrl === 'https://cdn.example.com/lib.mp4';
        r.assetIdSet = v.data.assetId === 'asset-video-9';
        r.nameSet = v.data.name === '库视频.mp4';
        return r;
    })()`);
    assert('pick.fnExists', rPick.fnExists, rPick.fnExists);
    assert('pick.filterVideo', rPick.filterVideo, rPick.filterVideo);
    assert('pick.videoUrlSet', rPick.videoUrlSet, rPick.videoUrlSet);
    assert('pick.assetIdSet', rPick.assetIdSet, rPick.assetIdSet);
    assert('pick.nameSet', rPick.nameSet, rPick.nameSet);

    // ============ 4. 视频节点右键菜单包含上传/选库/入库入口 ============
    const rMenu = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 1300, 100);
        v.data.videoUrl = 'https://cdn.example.com/res.mp4';
        CM.renderNodes();
        const el = document.querySelector('.cnode[data-id="' + v.id + '"]');
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        const menu = document.getElementById('canvasContextMenu');
        const texts = menu ? Array.from(menu.querySelectorAll('.canvas-menu-item, [data-act], div')).map(d => d.textContent.trim()) : [];
        r.hasUpload = texts.some(t => t.includes('上传本机视频'));
        r.hasPickLib = texts.some(t => t.includes('从素材库选择视频'));
        r.hasSync = texts.some(t => t.includes('同步到素材库'));
        CM._hideContextMenu();
        return r;
    })()`);
    assert('menu.hasUpload', rMenu.hasUpload, rMenu);
    assert('menu.hasPickLib', rMenu.hasPickLib, rMenu);
    assert('menu.hasSync', rMenu.hasSync, rMenu);

    // ============ 5. 生成链路：素材库视频（asset://）作为参考视频 ============
    const rGen = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const lib = JSON.parse(localStorage.getItem('aistudio_material_library') || '[]');
        lib.push({ id: 'asset-video-1', assetId: 'asset-video-1', status: 'active', name: 'ref.mp4', mtype: 'video', url: 'https://cdn.example.com/reflib.mp4' });
        localStorage.setItem('aistudio_material_library', JSON.stringify(lib));
        if (typeof MaterialLib !== 'undefined' && MaterialLib._cache) MaterialLib._cache = null;
        const src = CM.addNode('video', 100, 400, { assetId: 'asset-video-1', videoUrl: 'https://cdn.example.com/reflib.mp4', name: 'ref.mp4' });
        const v = CM.addNode('video', 400, 400, { duration: 5, promptOwn: '素材库视频参考', model: 'doubao-seedance-v4' });
        CM._connect(src.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-vr1' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/vr-out.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            refVideos: captured ? captured.referenceVideos : 'NO-CAPTURE',
            refAudios: captured ? captured.referenceAudios : 'NO-CAPTURE',
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            err: v.data.error || '',
        };
    })()`);
    assert('gen.videoDone', rGen.status === 'done', rGen);
    assert('gen.assetVideoRef',
        JSON.stringify(rGen.refVideos) === JSON.stringify(['asset://asset-video-1']), rGen.refVideos);
    assert('gen.noFirstFrame', rGen.firstFrameUrl === null, rGen.firstFrameUrl);

    // ============ 6. 生成链路：本机上传视频（data:）→ 自动托管转 URL 参考 ============
    const rGen2 = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const src = CM.addNode('video', 100, 600);
        src.data.videoUrl = 'data:video/mp4;base64,AAAA';
        src.data.name = 'local.mp4';
        const v = CM.addNode('video', 400, 600, { duration: 5, promptOwn: '本机视频参考', model: 'doubao-seedance-v4' });
        CM._connect(src.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        const origUpload = VideoModule._uploadToTempHost.bind(VideoModule);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-vr2' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/vr2-out.mp4' });
        VideoModule._uploadToTempHost = async (dataUrl, name) => 'https://tmp.example.com/' + (name || 'file');
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
            VideoModule._uploadToTempHost = origUpload;
        }
        return {
            status: v.data.status,
            refVideos: captured ? captured.referenceVideos : 'NO-CAPTURE',
            err: v.data.error || '',
        };
    })()`);
    assert('gen2.localVideoDone', rGen2.status === 'done', rGen2);
    assert('gen2.localVideoHostedRef',
        JSON.stringify(rGen2.refVideos) === JSON.stringify(['https://tmp.example.com/local.mp4']), rGen2.refVideos);

    // ============ 7. 视频入库（_syncVideoToLib）：data URL → 上传 → assetId ============
    const rSync = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 700, 400);
        v.data.videoUrl = 'data:video/mp4;base64,BBBB';
        v.data.name = 'result.mp4';
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => {
            r.uploadedName = file.name; r.uploadedType = file.type;
            return 'https://cdn.example.com/result.mp4';
        };
        const lib = JSON.parse(localStorage.getItem('aistudio_material_library') || '[]');
        lib.push({ id: 'asset-video-2', assetId: 'asset-video-2', status: 'active', name: 'result.mp4', mtype: 'video', url: 'https://cdn.example.com/result.mp4' });
        localStorage.setItem('aistudio_material_library', JSON.stringify(lib));
        if (typeof MaterialLib !== 'undefined' && MaterialLib._cache) MaterialLib._cache = null;
        try { await CM._syncVideoToLib(v); } finally { MaterialLib.uploadFile = origUpload; }
        r.assetIdSet = v.data.assetId === 'asset-video-2';
        return r;
    })()`);
    assert('sync.assetIdSet', rSync.assetIdSet, rSync);
    assert('sync.uploadedAsMp4', rSync.uploadedType === 'video/mp4' && rSync.uploadedName === 'result.mp4', rSync);

    // ============ 8. 图片下载按钮点击（stub UI.downloadFile 捕获参数） ============
    const rDl = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const img = CM.addNode('image', 1000, 400, { url: 'https://example.com/x.png', name: '美图.png' });
        const orig = UI.downloadFile.bind(UI);
        let captured = null;
        UI.downloadFile = async (url, name) => { captured = { url, name }; };
        try {
            document.querySelector('.cnode[data-id="' + img.id + '"] .cnode-act-img-download').click();
        } finally { UI.downloadFile = orig; }
        r.calledUrl = captured ? captured.url : null;
        r.calledName = captured ? captured.name : null;
        return r;
    })()`);
    assert('dl.calledWithNodeUrl', rDl.calledUrl === 'https://example.com/x.png', rDl.calledUrl);
    assert('dl.filename', typeof rDl.calledName === 'string' && rDl.calledName.length > 0, rDl.calledName);

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'videoref.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'videoref.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
