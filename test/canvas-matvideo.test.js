// 画布：视频节点→素材库入库通道 / 视频素材节点审核状态 / 参考生视频链路 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-matvideo-test'));

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

    // ============ 1. 连线规则：video → material 允许 ============
    const rRules = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        r.ruleHasMaterial = (CM._EDGE_RULES.video || []).includes('material');
        const v = CM.addNode('video', 100, 100);
        v.data.videoUrl = 'data:video/mp4;base64,AAAA';
        const m = CM.addNode('material', 400, 100);
        r.canConnect = CM._canConnect(v.id, m.id);
        return r;
    })()`);
    assert('rules.edgeRuleVideoMaterial', rRules.ruleHasMaterial, rRules.ruleHasMaterial);
    assert('rules.canConnectVideoToMaterial', rRules.canConnect, rRules.canConnect);

    // ============ 2. _materializeVideo：已入库视频直接继承引用 ============
    const rInherit = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 100, 400);
        v.data.videoUrl = 'https://cdn.example.com/done.mp4';
        v.data.assetId = 'asset-inherit-1';
        v.data.name = '成片.mp4';
        const before = CM.nodes.length;
        CM._materializeVideo(v.id, 500, 400);
        r.nodeAdded = CM.nodes.length === before + 1;
        const m = CM.nodes[CM.nodes.length - 1];
        r.mtypeVideo = m.type === 'material' && m.data.mtype === 'video';
        r.urlInherited = m.data.url === 'https://cdn.example.com/done.mp4';
        r.assetIdInherited = m.data.assetId === 'asset-inherit-1';
        r.noUploading = !m.data.uploading;
        r.edgeCreated = CM.edges.some(e => e.from === v.id && e.to === m.id);
        // DOM：视频预览 + 同步按钮 + 审核徽标
        const el = document.querySelector('.cnode[data-id="' + m.id + '"]');
        r.hasVideoEl = !!el.querySelector('.cnode-mat-video');
        r.hasSyncBtn = !!el.querySelector('.cnode-act-matsync');
        r.badgeText = el.querySelector('.cnode-lib-badge')?.textContent || '';
        r.badgeOk = el.querySelector('.cnode-lib-badge')?.classList.contains('ok');
        return r;
    })()`);
    assert('inherit.nodeAdded', rInherit.nodeAdded, rInherit.nodeAdded);
    assert('inherit.mtypeVideo', rInherit.mtypeVideo, rInherit.mtypeVideo);
    assert('inherit.urlInherited', rInherit.urlInherited, rInherit.urlInherited);
    assert('inherit.assetIdInherited', rInherit.assetIdInherited, rInherit.assetIdInherited);
    assert('inherit.noUploading', rInherit.noUploading, rInherit.noUploading);
    assert('inherit.edgeCreated', rInherit.edgeCreated, rInherit.edgeCreated);
    assert('inherit.hasVideoEl', rInherit.hasVideoEl, rInherit.hasVideoEl);
    assert('inherit.hasSyncBtn', rInherit.hasSyncBtn, rInherit.hasSyncBtn);
    assert('inherit.badgeApproved', rInherit.badgeText === '审核通过' && rInherit.badgeOk, rInherit.badgeText);

    // ============ 3. _materializeVideo：未入库视频自动上传并跟踪审核 ============
    const rUpload = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        const origGetAll = MaterialLib.getAll.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => 'https://hosted.example.com/ref.mp4';
        MaterialLib.getAll = () => [{ id: 'asset-mv-77', url: 'https://hosted.example.com/ref.mp4', name: '托管视频.mp4', status: 'processing' }];
        try {
            const v = CM.addNode('video', 100, 700);
            v.data.videoUrl = 'data:video/mp4;base64,AAAA';
            v.data.name = '本机视频.mp4';
            CM._materializeVideo(v.id, 500, 700);
            const m = CM.nodes[CM.nodes.length - 1];
            r.uploadingStarted = m.data.uploading === true;
            await new Promise(res => setTimeout(res, 600));
            const nn = CM.getNode(m.id);
            r.assetIdFromUpload = nn.data.assetId === 'asset-mv-77';
            r.uploadingCleared = !nn.data.uploading;
            r.urlSwapped = nn.data.url === 'https://hosted.example.com/ref.mp4';
            r.nameFromLib = nn.data.name === '托管视频.mp4';
            const badge = document.querySelector('.cnode[data-id="' + m.id + '"] .cnode-lib-badge');
            r.badgeProcessing = badge?.textContent === '审核中' && badge.classList.contains('busy');
            // 空视频节点拒绝入库
            const v2 = CM.addNode('video', 100, 1000);
            const cnt = CM.nodes.length;
            CM._materializeVideo(v2.id, 500, 1000);
            r.rejectsEmpty = CM.nodes.length === cnt;
        } finally {
            MaterialLib.uploadFile = origUpload;
            MaterialLib.getAll = origGetAll;
        }
        return r;
    })()`);
    assert('upload.uploadingStarted', rUpload.uploadingStarted, rUpload.uploadingStarted);
    assert('upload.assetIdFromUpload', rUpload.assetIdFromUpload, rUpload.assetIdFromUpload);
    assert('upload.uploadingCleared', rUpload.uploadingCleared, rUpload.uploadingCleared);
    assert('upload.urlSwapped', rUpload.urlSwapped, rUpload.urlSwapped);
    assert('upload.nameFromLib', rUpload.nameFromLib, rUpload.nameFromLib);
    assert('upload.badgeProcessing', rUpload.badgeProcessing, rUpload.badgeProcessing);
    assert('upload.rejectsEmpty', rUpload.rejectsEmpty, rUpload.rejectsEmpty);

    // ============ 4. 生成链路：素材库视频作参考视频（asset://），审核拦截生效 ============
    const rGen = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        // 4a. 审核中/未入库 → 禁止生成
        const v1 = CM.addNode('video', 100, 1300);
        v1.data.model = 'test-video-model';
        const m1 = CM.addNode('material', 500, 1300, { mtype: 'video', url: 'https://x.example.com/a.mp4', name: '参考视频A' });
        CM.edges.push({ id: CM._uid('edge'), from: m1.id, to: v1.id });
        await CM.generateVideo(v1.id);
        r.blockedNoAsset = !!v1.data.error && v1.data.status === 'idle';
        r.blockedMsg = (v1.data.error || '').includes('入库') || (v1.data.error || '').includes('审核');
        // 4b. 审核通过 → asset:// 进 referenceVideos，不进 referenceImages
        let captured = null;
        const origCreate = API.createVideoTask.bind(API);
        API.createVideoTask = async (params) => { captured = params; throw new Error('stop-matvideo-test'); };
        const origPoll = API.pollVideoTask;
        try {
            const v2 = CM.addNode('video', 100, 1600);
            v2.data.model = 'test-video-model';
            v2.data.promptOwn = '参考生视频';
            const m2 = CM.addNode('material', 500, 1600, { mtype: 'video', url: 'https://x.example.com/b.mp4', assetId: 'asset-ref-9', name: '参考视频B' });
            CM.edges.push({ id: CM._uid('edge'), from: m2.id, to: v2.id });
            await CM.generateVideo(v2.id);
            r.apiCalled = captured !== null;
            r.refVideos = captured ? captured.referenceVideos : null;
            r.refImages = captured ? captured.referenceImages : null;
            r.usesAsset = !!(captured && captured.referenceVideos && captured.referenceVideos[0] === 'asset://asset-ref-9');
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return r;
    })()`);
    assert('gen.blockedNoAsset', rGen.blockedNoAsset, rGen.blockedNoAsset);
    assert('gen.blockedMsg', rGen.blockedMsg, rGen.blockedMsg);
    assert('gen.apiCalled', rGen.apiCalled, rGen.apiCalled);
    assert('gen.refVideosAsset', rGen.usesAsset, rGen.refVideos);
    assert('gen.refImagesEmpty', rGen.refImages === null || (Array.isArray(rGen.refImages) && rGen.refImages.length === 0), rGen.refImages);

    // ============ 5. 参考标签：素材库视频标「视频N」 ============
    const rLabels = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 100, 1900);
        const img = CM.addNode('image', 400, 1900);
        const mi = CM.addNode('material', 700, 1900, { mtype: 'image', url: 'https://x.example.com/i.png' });
        const mv = CM.addNode('material', 1000, 1900, { mtype: 'video', url: 'https://x.example.com/v.mp4' });
        CM.edges.push({ id: CM._uid('edge'), from: img.id, to: v.id });
        CM.edges.push({ id: CM._uid('edge'), from: mi.id, to: v.id });
        CM.edges.push({ id: CM._uid('edge'), from: mv.id, to: v.id });
        CM._updateRefLabels(v);
        const labels = Array.from(document.querySelectorAll('.cnode[data-id="' + v.id + '"] .cnode-ref-label')).map(t => t.textContent);
        r.labels = labels;
        r.imgFirst = labels[0] === '图片1';
        r.imgSecond = labels[1] === '图片2';
        r.videoThird = labels[2] === '视频1';
        return r;
    })()`);
    assert('labels.imgFirst', rLabels.imgFirst, rLabels.labels);
    assert('labels.imgSecond', rLabels.imgSecond, rLabels.labels);
    assert('labels.videoThird', rLabels.videoThird, rLabels.labels);

    // ============ 6. 素材选择器按类型过滤 + 右键同步菜单 ============
    const rPick = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const orig = MaterialLib.openPicker.bind(MaterialLib);
        let captured = null;
        MaterialLib.openPicker = (cb, type) => { captured = type; };
        try {
            const mv = CM.addNode('material', 100, 2200, { mtype: 'video' });
            CM._pickMaterial(mv);
            r.videoFilter = captured === 'video';
            const mi = CM.addNode('material', 400, 2200, { mtype: 'image' });
            CM._pickMaterial(mi);
            r.imageFilter = captured === 'image';
        } finally { MaterialLib.openPicker = orig; }
        return r;
    })()`);
    assert('pick.videoFilter', rPick.videoFilter, rPick.videoFilter);
    assert('pick.imageFilter', rPick.imageFilter, rPick.imageFilter);

    // ============ 结果落盘 ============
    const out = 'PASS ' + (lines.filter(l => l.startsWith('PASS')).length) + ' / FAIL ' + failures;
    lines.push('SUMMARY ' + out);
    fs.writeFileSync(path.join(__dirname, 'matvideo.result.txt'), lines.join('\n') + '\n', 'utf8');
    console.log('SUMMARY: ' + out);
    app.exit(failures > 0 ? 1 : 0);
})().catch(e => {
    lines.push('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(__dirname, 'matvideo.result.txt'), lines.join('\n') + '\n', 'utf8'); } catch (_) {}
    console.error('FATAL', e);
    app.exit(1);
});
