// 画布视频生成：首帧/参考图混用约束测试
// 火山 400: "first/last frame content cannot be mixed with reference media content"
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-videomix-test'));

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
    await sleep(1500); // 等重渲染稳定

    // —— 场景A：两个图片节点连线到视频节点 → 参考图模式（不设首帧） ——
    const rA = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const img1 = CM.addNode('image', 100, 100, { url: 'https://example.com/a.jpg', name: 'A' });
        const img2 = CM.addNode('image', 100, 300, { url: 'https://example.com/b.jpg', name: 'B' });
        const v = CM.addNode('video', 400, 200, { duration: 5, promptOwn: '测试提示词', model: 'doubao-seedance-v4' });
        CM._connect(img1.id, v.id);
        CM._connect(img2.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-t1' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/out.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            hasFirstFrameKey: captured ? ('firstFrameUrl' in captured) : false,
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            refImages: captured?.referenceImages,
            prompt: captured?.prompt,
            err: v.data.error || '',
        };
    })()`);
    assert('A.videoDone', rA.status === 'done', rA);
    assert('A.noFirstFrame', rA.hasFirstFrameKey && rA.firstFrameUrl === null, rA.firstFrameUrl);
    assert('A.bothAsRefImages', Array.isArray(rA.refImages) && rA.refImages.length === 2, rA.refImages);
    assert('A.promptKept', (rA.prompt || '').includes('测试提示词'), rA.prompt);

    // —— 场景B：单个图片节点 → 首帧模式（保持原行为） ——
    const rB = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        const img = CM.addNode('image', 100, 500, { url: 'https://example.com/single.jpg', name: 'S' });
        const v = CM.addNode('video', 400, 500, { duration: 5, promptOwn: '单图', model: 'doubao-seedance-v4' });
        CM._connect(img.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-t2' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/out2.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            refImages: captured?.referenceImages,
        };
    })()`);
    assert('B.videoDone', rB.status === 'done', rB);
    assert('B.firstFrameSet', rB.firstFrameUrl === 'https://example.com/single.jpg', rB.firstFrameUrl);
    assert('B.noRefImages', rB.refImages === null || rB.refImages === undefined, rB.refImages);

    // —— 场景C：三个媒体（2图+1素材库）→ 全部参考图模式 ——
    const rC = await win.webContents.executeJavaScript(`(async () => {
        const CM = CanvasModule;
        // 造一条审核通过的素材记录供校验通过
        const assetId = 'asset-mock-1';
        const lib = JSON.parse(localStorage.getItem('aistudio_material_library') || '[]');
        lib.push({ id: assetId, assetId, status: 'active', name: 'M', mtype: 'image', url: 'https://example.com/m.jpg' });
        localStorage.setItem('aistudio_material_library', JSON.stringify(lib));
        if (typeof MaterialLib !== 'undefined' && MaterialLib._cache) MaterialLib._cache = null;
        const img1 = CM.addNode('image', 700, 100, { url: 'https://example.com/c.jpg', name: 'C' });
        const img2 = CM.addNode('image', 700, 300, { url: 'https://example.com/d.jpg', name: 'D' });
        const mat = CM.addNode('material', 700, 500, { assetId, url: 'https://example.com/m.jpg', name: 'M', mtype: 'image' });
        const v = CM.addNode('video', 1000, 300, { duration: 5, promptOwn: '三媒体', model: 'doubao-seedance-v4' });
        CM._connect(img1.id, v.id);
        CM._connect(img2.id, v.id);
        CM._connect(mat.id, v.id);
        const origCreate = API.createVideoTask.bind(API);
        const origPoll = API.pollVideoTask.bind(API);
        let captured = null;
        API.createVideoTask = async (params) => { captured = params; return { task_id: 'mock-t3' }; };
        API.pollVideoTask = async () => ({ url: 'https://cdn.example.com/out3.mp4' });
        try {
            await CM.generateVideo(v.id);
        } finally {
            API.createVideoTask = origCreate;
            API.pollVideoTask = origPoll;
        }
        return {
            status: v.data.status,
            firstFrameUrl: captured ? captured.firstFrameUrl : 'NO-CAPTURE',
            refImages: captured?.referenceImages,
            err: v.data.error || '',
        };
    })()`);
    assert('C.videoDone', rC.status === 'done', rC);
    assert('C.noFirstFrame', rC.firstFrameUrl === null, rC.firstFrameUrl);
    assert('C.threeAsRefImages', Array.isArray(rC.refImages) && rC.refImages.length === 3, rC.refImages);
    assert('C.assetRefKept', Array.isArray(rC.refImages) && rC.refImages.some(u => String(u).startsWith('asset://')), rC.refImages);

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'videomix.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'videomix.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
