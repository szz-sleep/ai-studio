// 画布：音频节点→素材库入库通道 / 素材节点输入端口锚定 / 音频素材参考链路 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-mataudio-test'));

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

    // ============ 1. 连线规则 + 端口锚定 ============
    const rRules = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        r.ruleHasMaterial = (CM._EDGE_RULES.audio || []).includes('material');
        const a = CM.addNode('audio', 100, 100);
        a.data.url = 'data:audio/mpeg;base64,AAAA';
        const m = CM.addNode('material', 500, 100);
        r.canConnect = CM._canConnect(a.id, m.id);
        // 素材节点应有左侧输入端口，且锚定在标题栏高度（与其他节点一致）
        const el = document.querySelector('.cnode[data-id="' + m.id + '"]');
        r.hasInPort = !!el.querySelector('.cnode-port-in');
        const p2 = CM._portPos(m.id, 'in');
        r.portYNearTop = p2 ? (p2.y - m.y) < 40 : false;
        // 无端口的其他类型回退值是边中点，这里验证素材节点不再用回退
        r.usesPortAnchor = p2 ? Math.abs((p2.y - m.y) - (el.querySelector('.cnode-port-in').offsetTop + 7)) < 2 : false;
        return r;
    })()`);
    assert('rules.edgeRuleAudioMaterial', rRules.ruleHasMaterial, rRules.ruleHasMaterial);
    assert('rules.canConnectAudioToMaterial', rRules.canConnect, rRules.canConnect);
    assert('rules.materialHasInPort', rRules.hasInPort, rRules.hasInPort);
    assert('rules.portYNearTop', rRules.portYNearTop, rRules.portYNearTop);
    assert('rules.usesPortAnchor', rRules.usesPortAnchor, rRules.usesPortAnchor);

    // ============ 2. 素材节点 DOM：音频预览 + 同步按钮 ============
    const rDom = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const ma = CM.addNode('material', 100, 400, { mtype: 'audio', url: 'https://x.example.com/a.mp3', name: '库音频.mp3' });
        const el = document.querySelector('.cnode[data-id="' + ma.id + '"]');
        r.hasAudioEl = !!el.querySelector('.cnode-mat-audio');
        r.hasSyncBtn = !!el.querySelector('.cnode-act-matsync');
        r.hasBadge = !!el.querySelector('.cnode-lib-badge');
        r.audioVisible = el.querySelector('.cnode-mat-audio').style.display !== 'none';
        r.placeholderText = el.querySelector('.cnode-audio-placeholder')?.textContent || '';
        return r;
    })()`);
    assert('dom.hasAudioEl', rDom.hasAudioEl, rDom.hasAudioEl);
    assert('dom.hasSyncBtn', rDom.hasSyncBtn, rDom.hasSyncBtn);
    assert('dom.hasBadge', rDom.hasBadge, rDom.hasBadge);
    assert('dom.audioVisible', rDom.audioVisible, rDom.audioVisible);
    assert('dom.placeholder', rDom.placeholderText.includes('音频素材区'), rDom.placeholderText);

    // ============ 3. _materializeAudio：继承 / 自动上传 + 审核徽标 ============
    const rMat = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        // 3a. 已入库音频直接继承
        const a1 = CM.addNode('audio', 100, 700);
        a1.data.url = 'https://cdn.example.com/done.mp3';
        a1.data.assetId = 'asset-audio-inherit';
        a1.data.name = '成片配乐.mp3';
        CM._materializeAudio(a1.id, 500, 700);
        const m1 = CM.nodes[CM.nodes.length - 1];
        r.inheritMtype = m1.type === 'material' && m1.data.mtype === 'audio';
        r.inheritAsset = m1.data.assetId === 'asset-audio-inherit';
        r.inheritNoUpload = !m1.data.uploading;
        r.inheritEdge = CM.edges.some(e => e.from === a1.id && e.to === m1.id);
        // 3b. 未入库音频自动上传并跟踪审核
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        const origGetAll = MaterialLib.getAll.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => 'https://hosted.example.com/a.mp3';
        MaterialLib.getAll = () => [{ id: 'asset-audio-77', url: 'https://hosted.example.com/a.mp3', name: '托管音频.mp3', status: 'processing' }];
        try {
            const a2 = CM.addNode('audio', 100, 1000);
            a2.data.url = 'data:audio/mpeg;base64,AAAA';
            a2.data.name = '本机音频.mp3';
            CM._materializeAudio(a2.id, 500, 1000);
            const m2 = CM.nodes[CM.nodes.length - 1];
            r.uploadStarted = m2.data.uploading === true;
            await new Promise(res => setTimeout(res, 600));
            const nn = CM.getNode(m2.id);
            r.assetFromUpload = nn.data.assetId === 'asset-audio-77';
            r.uploadCleared = !nn.data.uploading;
            r.urlKept = nn.data.url === 'data:audio/mpeg;base64,AAAA' && nn.data.sourceUrl === 'https://hosted.example.com/a.mp3';
            const badge = document.querySelector('.cnode[data-id="' + m2.id + '"] .cnode-lib-badge');
            r.badgeProcessing = badge?.textContent === '审核中' && badge.classList.contains('busy');
            // 空音频节点拒绝
            const a3 = CM.addNode('audio', 100, 1300);
            const cnt = CM.nodes.length;
            CM._materializeAudio(a3.id, 500, 1300);
            r.rejectsEmpty = CM.nodes.length === cnt;
        } finally {
            MaterialLib.uploadFile = origUpload;
            MaterialLib.getAll = origGetAll;
        }
        return r;
    })()`);
    assert('mat.inheritMtype', rMat.inheritMtype, rMat.inheritMtype);
    assert('mat.inheritAsset', rMat.inheritAsset, rMat.inheritAsset);
    assert('mat.inheritNoUpload', rMat.inheritNoUpload, rMat.inheritNoUpload);
    assert('mat.inheritEdge', rMat.inheritEdge, rMat.inheritEdge);
    assert('mat.uploadStarted', rMat.uploadStarted, rMat.uploadStarted);
    assert('mat.assetFromUpload', rMat.assetFromUpload, rMat.assetFromUpload);
    assert('mat.uploadCleared', rMat.uploadCleared, rMat.uploadCleared);
    assert('mat.urlKept', rMat.urlKept, rMat.urlKept);
    assert('mat.badgeProcessing', rMat.badgeProcessing, rMat.badgeProcessing);
    assert('mat.rejectsEmpty', rMat.rejectsEmpty, rMat.rejectsEmpty);

    // ============ 4. 生成链路：素材库音频作参考音频（asset://），审核拦截 ============
    const rGen = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        // 4a. 未入库 → 禁止生成
        const v1 = CM.addNode('video', 100, 1600);
        v1.data.model = 'test-video-model';
        const m1 = CM.addNode('material', 500, 1600, { mtype: 'audio', url: 'https://x.example.com/a.mp3', name: '参考音频A' });
        CM.edges.push({ id: CM._uid('edge'), from: m1.id, to: v1.id });
        await CM.generateVideo(v1.id);
        r.blockedNoAsset = !!v1.data.error && v1.data.status === 'idle';
        // 4b. 已入库 → asset:// 进 referenceAudios
        let captured = null;
        const origCreate = API.createVideoTask.bind(API);
        API.createVideoTask = async (params) => { captured = params; throw new Error('stop-mataudio-test'); };
        try {
            const v2 = CM.addNode('video', 100, 1900);
            v2.data.model = 'test-video-model';
            v2.data.promptOwn = '参考音频生成';
            const m2 = CM.addNode('material', 500, 1900, { mtype: 'audio', url: 'https://x.example.com/b.mp3', assetId: 'asset-audio-ref-9', name: '参考音频B' });
            CM.edges.push({ id: CM._uid('edge'), from: m2.id, to: v2.id });
            await CM.generateVideo(v2.id);
            r.apiCalled = captured !== null;
            r.refAudios = captured ? captured.referenceAudios : null;
            r.usesAsset = !!(captured && captured.referenceAudios && captured.referenceAudios[0] === 'asset://asset-audio-ref-9');
            r.refImagesClean = !captured || !captured.referenceImages;
            r.refVideosClean = !captured || !captured.referenceVideos;
        } finally {
            API.createVideoTask = origCreate;
        }
        return r;
    })()`);
    assert('gen.blockedNoAsset', rGen.blockedNoAsset, rGen.blockedNoAsset);
    assert('gen.apiCalled', rGen.apiCalled, rGen.apiCalled);
    assert('gen.refAudiosAsset', rGen.usesAsset, rGen.refAudios);
    assert('gen.refImagesClean', rGen.refImagesClean, rGen.refImagesClean);
    assert('gen.refVideosClean', rGen.refVideosClean, rGen.refVideosClean);

    // ============ 5. 参考标签：素材库音频标「音频N」 ============
    const rLabels = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const v = CM.addNode('video', 100, 2200);
        const ma = CM.addNode('material', 500, 2200, { mtype: 'audio', url: 'https://x.example.com/a.mp3' });
        const mv = CM.addNode('material', 800, 2200, { mtype: 'video', url: 'https://x.example.com/v.mp4' });
        CM.edges.push({ id: CM._uid('edge'), from: ma.id, to: v.id });
        CM.edges.push({ id: CM._uid('edge'), from: mv.id, to: v.id });
        CM._updateRefLabels(v);
        const labels = Array.from(document.querySelectorAll('.cnode[data-id="' + v.id + '"] .cnode-ref-label')).map(t => t.textContent);
        r.labels = labels;
        r.audioFirst = labels[0] === '音频1';
        r.videoSecond = labels[1] === '视频1';
        return r;
    })()`);
    assert('labels.audioFirst', rLabels.audioFirst, rLabels.labels);
    assert('labels.videoSecond', rLabels.videoSecond, rLabels.labels);

    // ============ 6. 素材选择器音频过滤 ============
    const rPick = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const orig = MaterialLib.openPicker.bind(MaterialLib);
        let captured = null;
        MaterialLib.openPicker = (cb, type) => { captured = type; };
        try {
            const ma = CM.addNode('material', 100, 2500, { mtype: 'audio' });
            CM._pickMaterial(ma);
            r.audioFilter = captured === 'audio';
        } finally { MaterialLib.openPicker = orig; }
        return r;
    })()`);
    assert('pick.audioFilter', rPick.audioFilter, rPick.audioFilter);

    // ============ 结果落盘 ============
    const out = 'PASS ' + (lines.filter(l => l.startsWith('PASS')).length) + ' / FAIL ' + failures;
    lines.push('SUMMARY ' + out);
    fs.writeFileSync(path.join(__dirname, 'mataudio.result.txt'), lines.join('\n') + '\n', 'utf8');
    console.log('SUMMARY: ' + out);
    app.exit(failures > 0 ? 1 : 0);
})().catch(e => {
    lines.push('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(__dirname, 'mataudio.result.txt'), lines.join('\n') + '\n', 'utf8'); } catch (_) {}
    console.error('FATAL', e);
    app.exit(1);
});
