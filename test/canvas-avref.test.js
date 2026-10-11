// 画布：音频节点 + 视频节点输出点 + 音频/视频参考生成链路 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-avref-test'));

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

    // ============ 1. 音频节点基础 + 视频节点输出点 + 连线规则 ============
    const rBase = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        r.toolbarHasAudio = !!document.getElementById('canvasAddAudioBtn');
        const a = CM.addNode('audio', 100, 100);
        r.audioBodyHasPlayer = !!document.querySelector('.cnode[data-id="' + a.id + '"] .cnode-audio-player');
        r.audioHasOutPort = !!document.querySelector('.cnode[data-id="' + a.id + '"] .cnode-port-out');
        r.audioNoInPort = !document.querySelector('.cnode[data-id="' + a.id + '"] .cnode-port-in');
        r.audioDataDefaults = a.data.url === '' && a.data.name === '' && a.data.assetId === null;
        const v = CM.addNode('video', 400, 100);
        r.videoHasOutPort = !!document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-port-out');
        r.videoHasInPort = !!document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-port-in');
        // 连线规则
        r.audioToVideo = CM._canConnect(a.id, v.id);
        const img = CM.addNode('image', 100, 300, { url: 'https://example.com/i.jpg', name: 'I' });
        r.audioToImageDenied = !CM._canConnect(a.id, img.id);
        r.videoToVideo = CM._canConnect(v.id, CM.addNode('video', 700, 100).id);
        // 双击提示：audio head 标题为「音频」
        r.audioTitle = document.querySelector('.cnode[data-id="' + a.id + '"] .cnode-title').textContent;
        return r;
    })()`);
    assert('base.toolbarHasAudio', rBase.toolbarHasAudio, rBase.toolbarHasAudio);
    assert('base.audioPlayer', rBase.audioBodyHasPlayer, rBase.audioBodyHasPlayer);
    assert('base.audioOutPort', rBase.audioHasOutPort, rBase.audioHasOutPort);
    assert('base.audioNoInPort', rBase.audioNoInPort, rBase.audioNoInPort);
    assert('base.audioDataDefaults', rBase.audioDataDefaults, rBase.audioDataDefaults);
    assert('base.videoOutPort', rBase.videoHasOutPort, rBase.videoHasOutPort);
    assert('base.videoInPort', rBase.videoHasInPort, rBase.videoHasInPort);
    assert('base.audioToVideo', rBase.audioToVideo, rBase.audioToVideo);
    assert('base.audioToImageDenied', rBase.audioToImageDenied, rBase.audioToImageDenied);
    assert('base.videoToVideo', rBase.videoToVideo, rBase.videoToVideo);
    assert('base.audioTitle', rBase.audioTitle === '音频', rBase.audioTitle);

    // ============ 2. 分类序号标签：图片N / 音频N / 视频N ============
    const rLabel = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        const CM = CanvasModule;
        const i1 = CM.addNode('image', 100, 500, { url: 'https://example.com/1.jpg', name: '一' });
        const i2 = CM.addNode('image', 100, 700, { url: 'https://example.com/2.jpg', name: '二' });
        const au = CM.addNode('audio', 100, 900, { url: 'data:audio/mp3;base64,AAAA', name: '配乐.mp3' });
        const vr = CM.addNode('video', 100, 1100);
        vr.data.videoUrl = 'https://cdn.example.com/ref.mp4';
        const v = CM.addNode('video', 500, 700, { duration: 5, model: 'doubao-seedance-v4' });
        CM._connect(i1.id, v.id);
        CM._connect(i2.id, v.id);
        CM._connect(au.id, v.id);
        CM._connect(vr.id, v.id);
        CM.renderEdges();
        const box = document.querySelector('.cnode[data-id="' + v.id + '"] .cnode-ref-labels');
        r.labelsShown = !!box;
        r.texts = box ? Array.from(box.querySelectorAll('.cnode-ref-label')).map(t => t.textContent) : [];
        // 点击音频标签 → 选中音频节点
        const audioTag = box && Array.from(box.querySelectorAll('.cnode-ref-label')).find(t => t.textContent === '音频1');
        if (audioTag) {
            audioTag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            audioTag.click();
        }
        r.audioSelected = CM.selection.has(au.id);
        r.audioRefPick = !!document.querySelector('.cnode[data-id="' + au.id + '"]')?.classList.contains('ref-pick');
        return r;
    })()`);
    assert('label.shown', rLabel.labelsShown, rLabel.labelsShown);
    assert('label.classifiedTexts',
        JSON.stringify(rLabel.texts) === JSON.stringify(['图片1', '图片2', '音频1', '视频1']), rLabel.texts);
    assert('label.clickSelectsAudio', rLabel.audioSelected, rLabel.audioSelected);
    assert('label.audioRefPick', rLabel.audioRefPick, rLabel.audioRefPick);

    // ============ 3. 生成链路：图 + 音频 → 多模态参考（不设首帧） ============
    const rGenA = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const img = CM.addNode('image', 1300, 100, { url: 'https://example.com/g.jpg', name: 'G' });
        const au = CM.addNode('audio', 1300, 300, { url: 'data:audio/mp3;base64,BBBB', name: 'voice.mp3' });
        const v = CM.addNode('video', 1600, 200, { duration: 5, promptOwn: '配音视频', model: 'doubao-seedance-v4' });
        CM._connect(img.id, v.id);
        CM._connect(au.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        const origUpload = VideoModule._uploadToTempHost.bind(VideoModule);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-av1' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/av-out.mp4' });
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
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            refImages: captured ? captured.referenceImages : 'NO-CAPTURE',
            refVideos: captured ? captured.referenceVideos : 'NO-CAPTURE',
            refAudios: captured ? captured.referenceAudios : 'NO-CAPTURE',
            err: v.data.error || '',
        };
    })()`);
    assert('genA.videoDone', rGenA.status === 'done', rGenA);
    assert('genA.noFirstFrame', rGenA.firstFrameUrl === null, rGenA.firstFrameUrl);
    assert('genA.imageAsRef',
        JSON.stringify(rGenA.refImages) === JSON.stringify(['https://example.com/g.jpg']), rGenA.refImages);
    assert('genA.audioUploadedAsRef',
        JSON.stringify(rGenA.refAudios) === JSON.stringify(['https://tmp.example.com/voice.mp3']), rGenA.refAudios);
    assert('genA.noRefVideos', rGenA.refVideos === null, rGenA.refVideos);

    // ============ 4. 生成链路：视频→视频 参考 + 音频在资源库(asset://) ============
    const rGenB = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const src = CM.addNode('video', 100, 1300);
        src.data.videoUrl = 'https://cdn.example.com/ref.mp4';
        const au = CM.addNode('audio', 100, 1500, { assetId: 'asset-audio-1', url: 'https://example.com/lib.mp3', name: 'lib.mp3' });
        const lib = JSON.parse(localStorage.getItem('aistudio_material_library') || '[]');
        lib.push({ id: 'asset-audio-1', assetId: 'asset-audio-1', status: 'active', name: 'lib.mp3', mtype: 'audio', url: 'https://example.com/lib.mp3' });
        localStorage.setItem('aistudio_material_library', JSON.stringify(lib));
        if (typeof MaterialLib !== 'undefined' && MaterialLib._cache) MaterialLib._cache = null;
        const v = CM.addNode('video', 400, 1400, { duration: 5, promptOwn: '视频参考', model: 'doubao-seedance-v4' });
        CM._connect(src.id, v.id);
        CM._connect(au.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-av2' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/vv-out.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            refVideos: captured ? captured.referenceVideos : 'NO-CAPTURE',
            refAudios: captured ? captured.referenceAudios : 'NO-CAPTURE',
            err: v.data.error || '',
        };
    })()`);
    assert('genB.videoDone', rGenB.status === 'done', rGenB);
    assert('genB.videoAsRef',
        JSON.stringify(rGenB.refVideos) === JSON.stringify(['https://cdn.example.com/ref.mp4']), rGenB.refVideos);
    assert('genB.audioAssetRef',
        JSON.stringify(rGenB.refAudios) === JSON.stringify(['asset://asset-audio-1']), rGenB.refAudios);
    assert('genB.noFirstFrame', rGenB.firstFrameUrl === null, rGenB.firstFrameUrl);

    // ============ 5. 生成链路：仅音频（无图）→ 纯音频参考也能生成 ============
    const rGenC = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const au = CM.addNode('audio', 700, 1300, { url: 'https://example.com/only.mp3', name: 'only.mp3' });
        const v = CM.addNode('video', 1000, 1300, { duration: 5, promptOwn: '纯音频', model: 'doubao-seedance-v4' });
        CM._connect(au.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-av3' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/a-out.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            refAudios: captured ? captured.referenceAudios : 'NO-CAPTURE',
            refImages: captured ? captured.referenceImages : 'NO-CAPTURE',
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            err: v.data.error || '',
        };
    })()`);
    assert('genC.audioOnlyDone', rGenC.status === 'done', rGenC);
    assert('genC.audioOnlyAsRef',
        JSON.stringify(rGenC.refAudios) === JSON.stringify(['https://example.com/only.mp3']), rGenC.refAudios);
    assert('genC.audioOnlyNoImages', rGenC.refImages === null, rGenC.refImages);
    assert('genC.audioOnlyNoFirstFrame', rGenC.firstFrameUrl === null, rGenC.firstFrameUrl);

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'avref.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'avref.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
