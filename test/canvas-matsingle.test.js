// 画布：素材节点单一接入限制 / 接入即吸收上传 / 统一「同步素材」入口 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-matsingle-test'));

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

    // ============ 1. 素材节点只接收 1 个接入节点 ============
    const rSingle = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const i1 = CM.addNode('image', 100, 100, { url: 'https://x.example.com/1.png' });
        const i2 = CM.addNode('image', 100, 300, { url: 'https://x.example.com/2.png' });
        const m = CM.addNode('material', 500, 100);
        CM._connect(i1.id, m.id);
        r.firstEdge = CM.edges.some(e => e.from === i1.id && e.to === m.id);
        r.secondDenied = !CM._canConnect(i2.id, m.id);
        const cnt = CM.edges.length;
        CM._connect(i2.id, m.id);
        r.noSecondEdge = CM.edges.length === cnt;
        return r;
    })()`);
    assert('single.firstEdge', rSingle.firstEdge, rSingle.firstEdge);
    assert('single.secondDenied', rSingle.secondDenied, rSingle.secondDenied);
    assert('single.noSecondEdge', rSingle.noSecondEdge, rSingle.noSecondEdge);

    // ============ 2. 连线即吸收：视频→素材节点 自动设置内容并上传 ============
    const rAbsorb = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        const origGetAll = MaterialLib.getAll.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => 'https://hosted.example.com/v.mp4';
        MaterialLib.getAll = () => [{ id: 'asset-absorb-1', url: 'https://hosted.example.com/v.mp4', name: '托管.mp4', status: 'processing' }];
        try {
            const v = CM.addNode('video', 100, 600);
            v.data.videoUrl = 'data:video/mp4;base64,AAAA';
            v.data.name = '接入视频.mp4';
            const m = CM.addNode('material', 500, 600);
            CM._connect(v.id, m.id);
            r.mtypeSet = m.data.mtype === 'video';
            r.urlSet = m.data.url === 'data:video/mp4;base64,AAAA';
            r.nameSet = m.data.name === '接入视频.mp4';
            r.uploading = m.data.uploading === true;
            await new Promise(res => setTimeout(res, 600));
            const nn = CM.getNode(m.id);
            r.assetUploaded = nn.data.assetId === 'asset-absorb-1';
            r.uploadCleared = !nn.data.uploading;
        } finally {
            MaterialLib.uploadFile = origUpload;
            MaterialLib.getAll = origGetAll;
        }
        return r;
    })()`);
    assert('absorb.mtypeSet', rAbsorb.mtypeSet, rAbsorb.mtypeSet);
    assert('absorb.urlSet', rAbsorb.urlSet, rAbsorb.urlSet);
    assert('absorb.nameSet', rAbsorb.nameSet, rAbsorb.nameSet);
    assert('absorb.uploading', rAbsorb.uploading, rAbsorb.uploading);
    assert('absorb.assetUploaded', rAbsorb.assetUploaded, rAbsorb.assetUploaded);
    assert('absorb.uploadCleared', rAbsorb.uploadCleared, rAbsorb.uploadCleared);

    // ============ 3. 统一同步入口：按接入素材刷新并正确分发 ============
    const rSync = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        // 3a. 陈旧 mtype 的素材节点接入已入库视频 → 刷新继承 assetId
        const v1 = CM.addNode('video', 100, 900);
        v1.data.videoUrl = 'https://cdn.example.com/lib.mp4';
        v1.data.assetId = 'asset-stale-fix';
        const m1 = CM.addNode('material', 500, 900, { mtype: 'image', url: 'https://old.example.com/x.png' });
        CM.edges.push({ id: CM._uid('edge'), from: v1.id, to: m1.id });
        await CM._syncMaterial(m1);
        r.refreshedMtype = m1.data.mtype === 'video';
        r.refreshedAsset = m1.data.assetId === 'asset-stale-fix';
        r.refreshedUrl = m1.data.url === 'https://cdn.example.com/lib.mp4';
        // 3b. 接入本机音频（无 assetId）→ 走音频上传
        const origUpload = MaterialLib.uploadFile.bind(MaterialLib);
        const origGetAll = MaterialLib.getAll.bind(MaterialLib);
        MaterialLib.uploadFile = async (file) => 'https://hosted.example.com/a.mp3';
        MaterialLib.getAll = () => [{ id: 'asset-audio-sync', url: 'https://hosted.example.com/a.mp3', status: 'processing' }];
        try {
            const a1 = CM.addNode('audio', 100, 1200);
            a1.data.url = 'data:audio/mpeg;base64,AAAA';
            const m2 = CM.addNode('material', 500, 1200);
            CM.edges.push({ id: CM._uid('edge'), from: a1.id, to: m2.id });
            await CM._syncMaterial(m2);
            r.audioDispatched = m2.data.mtype === 'audio' && m2.data.assetId === 'asset-audio-sync';
            // 3c. 无接入无内容 → 明确提示（不再误报图片错误）
            const m3 = CM.addNode('material', 500, 1500);
            await CM._syncMaterial(m3);
            r.emptyStillEmpty = !m3.data.url && !m3.data.assetId;
        } finally {
            MaterialLib.uploadFile = origUpload;
            MaterialLib.getAll = origGetAll;
        }
        return r;
    })()`);
    assert('sync.refreshedMtype', rSync.refreshedMtype, rSync.refreshedMtype);
    assert('sync.refreshedAsset', rSync.refreshedAsset, rSync.refreshedAsset);
    assert('sync.refreshedUrl', rSync.refreshedUrl, rSync.refreshedUrl);
    assert('sync.audioDispatched', rSync.audioDispatched, rSync.audioDispatched);
    assert('sync.emptyNoCrash', rSync.emptyStillEmpty, rSync.emptyStillEmpty);

    // ============ 4. 所有类型素材节点都有「同步素材」按钮 ============
    const rBtn = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const mi = CM.addNode('material', 100, 1800, { mtype: 'image', url: 'https://x.example.com/i.png' });
        r._idi = mi.id;
        const mv = CM.addNode('material', 400, 1800, { mtype: 'video', url: 'https://x.example.com/v.mp4' });
        r._idv = mv.id;
        const ma = CM.addNode('material', 700, 1800, { mtype: 'audio', url: 'https://x.example.com/a.mp3' });
        r._ida = ma.id;
        const mf = CM.addNode('material', 1000, 1800);
        r._idf = mf.id;
        const txt = (id) => {
            const el = document.querySelector('.cnode[data-id="' + id + '"]');
            const b = el ? el.querySelector('.cnode-act-matsync') : null;
            if (!el) r['dump_' + id] = 'NO-EL';
            else if (!b) r['dump_' + id] = ('NO-BTN :: ' + el.innerHTML).substring(0, 260);
            return b ? b.textContent : '';
        };
        r.imageBtn = txt(mi.id) === '同步素材';
        r.videoBtn = txt(mv.id) === '同步素材';
        r.audioBtn = txt(ma.id) === '同步素材';
        r.freshBtn = txt(mf.id) === '同步素材';
        r.debugTexts = [txt(mi.id), txt(mv.id), txt(ma.id), txt(mf.id)];
        return r;
    })()`);
    lines.push('RBUTTON ' + JSON.stringify(rBtn));
    assert('btn.image', rBtn.imageBtn, rBtn['dump_' + rBtn._idi]);
    assert('btn.video', rBtn.videoBtn, rBtn['dump_' + rBtn._idv]);
    assert('btn.audio', rBtn.audioBtn, rBtn['dump_' + rBtn._ida]);
    assert('btn.fresh', rBtn.freshBtn, rBtn['dump_' + rBtn._idf]);

    // ============ 结果落盘 ============
    const out = 'PASS ' + (lines.filter(l => l.startsWith('PASS')).length) + ' / FAIL ' + failures;
    lines.push('SUMMARY ' + out);
    fs.writeFileSync(path.join(__dirname, 'matsingle.result.txt'), lines.join('\n') + '\n', 'utf8');
    console.log('SUMMARY: ' + out);
    app.exit(failures > 0 ? 1 : 0);
})().catch(e => {
    lines.push('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(__dirname, 'matsingle.result.txt'), lines.join('\n') + '\n', 'utf8'); } catch (_) {}
    console.error('FATAL', e);
    app.exit(1);
});
