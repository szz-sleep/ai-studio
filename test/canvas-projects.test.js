/**
 * 画布项目库 + 图片入库通道回归测试：
 *  A. 旧数据迁移 → 默认项目
 *  B. 项目新建/切换/隔离/重命名/复制/删除 + 面板渲染
 *  C. image→material 连线放开 + _materializeImage 自动入库（原图保留）+ 审核状态徽标联动
 *  D. generateVideo 素材审核严格校验（未入库/审核中/审核失败均阻止）
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test\canvas-projects.test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'aistudio-canvas-projects-test'));
const RESULT_FILE = path.join(__dirname, 'canvas-projects.result.txt');
const lines = [];
const flush = () => { try { fs.writeFileSync(RESULT_FILE, lines.join('\n')); } catch (e) {} };
const out = (s) => { lines.push(s); flush(); };
let failures = 0;
const assert = (name, cond, extra) => {
    if (cond) out(`PASS ${name}`);
    else { failures++; out(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1500, height: 900, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    const consoleErrors = [];
    win.webContents.on('console-message', (e, level, message) => {
        if (level >= 3) consoleErrors.push(message);
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);

    // ============ A+B. 项目库 ============
    let r = null, err = null;
    try {
        r = await win.webContents.executeJavaScript(`(async () => {
            const r = {};
            const CM = (typeof CanvasModule !== 'undefined') ? CanvasModule : window.CanvasModule;
            if (!CM) throw new Error('CanvasModule not found');
            const sleep = ms => new Promise(res => setTimeout(res, ms));

            // 清空画布存储，做迁移测试
            localStorage.removeItem(CM.PROJECTS_KEY);
            localStorage.removeItem(CM.PROJECT_CURRENT_KEY);
            localStorage.setItem(CM.STORAGE_KEY, JSON.stringify({
                nodes: [{ id: 'text_m1', type: 'text', x: 0, y: 0, w: 240, h: 0, data: { text: 'legacy' } }],
                edges: [], viewport: { x: 1, y: 2, k: 1.5 },
            }));
            await CM._restore();
            const p1 = CM.currentProjectId;
            r.migrated = CM._projects().length === 1
                && CM._projects()[0].name === '默认项目'
                && CM.nodes.length === 1
                && CM.nodes[0].id === 'text_m1'
                && !!p1;

            // 项目内加一个图片节点
            const img = CM.addNode('image', 50, 50);
            await CM._saveNow();
            const p1NodeCount = CM.nodes.length;

            // 新建项目 → 空画布 + 切换（持久化改磁盘后这些方法均为 async）
            const p2 = await CM._createProject('测试B');
            r.created = !!p2 && CM.currentProjectId === p2.id && CM.nodes.length === 0;
            // P2 内加视频节点
            CM.addNode('video', 0, 0);
            await CM._saveNow();
            // 切回 P1：数据隔离
            await CM._loadProject(p1);
            r.isolationP1 = CM.currentProjectId === p1 && CM.nodes.length === p1NodeCount
                && CM.nodes.some(n => n.id === img.id);
            // 再切到 P2：视频节点还在
            await CM._loadProject(p2.id);
            r.isolationP2 = CM.currentProjectId === p2.id && CM.nodes.some(n => n.type === 'video');
            // 重命名
            CM._renameProject(p2.id, '改名B');
            r.renamed = CM._projects().find(p => p.id === p2.id).name === '改名B';
            // 复制
            await CM._duplicateProject(p2.id);
            const copy = CM._projects().find(p => p.name === '改名B 副本');
            r.duplicated = !!copy && CM.currentProjectId === p2.id;
            // 删除副本（非当前项目）
            await CM._deleteProject(copy.id);
            r.deletedCopy = !CM._projects().find(p => p.id === copy.id) && CM.currentProjectId === p2.id;
            // 删除当前项目 → 落到剩余第一个
            await CM._deleteProject(p2.id);
            r.deletedCurrent = CM.currentProjectId !== p2.id && CM._projects().length === 1;
            // 面板渲染
            CM._renderProjects();
            const listEl = document.getElementById('canvasProjectsList');
            r.panelItems = listEl.children.length === CM._projects().length;
            r.panelActive = !!listEl.querySelector('.canvas-project-item.active');
            // 面板收起/展开
            const panel = document.getElementById('canvasProjectsPanel');
            document.getElementById('canvasProjectsHandle').click();
            r.panelOpens = !panel.classList.contains('hidden');
            document.getElementById('canvasProjectsHandle').click();
            r.panelCloses = panel.classList.contains('hidden');
            // 撤销栈已清空（切换项目后）
            r.undoCleared = CM._undoStack.length === 0 && CM._redoStack.length === 0;
            return r;
        })()`);
    } catch (e) { err = String(e && e.message || e); }
    if (err) out(`ERROR projects-block: ${err}`);
    ['migrated','created','isolationP1','isolationP2','renamed','duplicated','deletedCopy','deletedCurrent',
     'panelItems','panelActive','panelOpens','panelCloses','undoCleared']
        .forEach(k => { if (r) assert(`projects.${k}`, r[k], r[k]); });

    // ============ C. 图片入库通道 ============
    r = null; err = null;
    try {
        r = await win.webContents.executeJavaScript(`(async () => {
            const r = {};
            const CM = CanvasModule;
            const sleep = ms => new Promise(res => setTimeout(res, ms));
            const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

            // 连线规则放开
            r.ruleAllowsMaterial = (CM._EDGE_RULES.image || []).includes('material');

            // 图片节点（原图 dataURL，未入库）
            const img = CM.addNode('image', 50, 50);
            img.data.url = TINY;
            img.data.name = '原图.png';
            CM.renderAll();

            // mock MaterialLib.uploadFile：返回托管 URL 并写入 processing 记录
            const origUpload = MaterialLib.uploadFile;
            let uploadCalls = 0;
            MaterialLib.uploadFile = async (file) => {
                uploadCalls++;
                MaterialLib._upsert({ id: 'maas_test_1', name: 'img.png', url: 'http://host/img.png', sourceUrl: 'http://host/img.png', type: 'image', status: 'processing', time: Date.now() });
                return 'http://host/img.png';
            };
            try {
                CM._materializeImage(img.id, 260, 260);
                const mat = CM.nodes.find(n => n.type === 'material' && n.data.name === '原图.png');
                r.materialCreated = !!mat;
                r.edgeCreated = mat && CM.edges.some(e => e.from === img.id && e.to === mat.id);
                r.imageKept = img.data.url === TINY;
                r.uploadStarted = mat && mat.data.uploading === true;
                await sleep(600);
                r.uploaded = mat && mat.data.assetId === 'maas_test_1' && uploadCalls === 1;
                r.badgeProcessing = mat && CM._libBadgeInfo(mat).text === '审核中';
                // 审核通过事件联动
                MaterialLib._upsert({ id: 'maas_test_1', status: 'active' });
                document.dispatchEvent(new CustomEvent('aistudio-material-cache'));
                await sleep(100);
                const badgeEl = document.querySelector('.cnode[data-id="' + mat.id + '"] .cnode-lib-badge');
                r.badgeActiveEvent = badgeEl && badgeEl.textContent === '审核通过' && badgeEl.classList.contains('ok');
                // 图片节点的徽标不受影响（未入库）
                const imgBadge = document.querySelector('.cnode[data-id="' + img.id + '"] .cnode-lib-badge');
                r.imageBadgeUntouched = imgBadge && imgBadge.textContent === '未入库';

                // ============ D. 生成严格校验 ============
                const vid = CM.addNode('video', 400, 60);
                vid.data.model = 'test-model';
                CM.edges.push({ id: CM._uid('edge'), from: mat.id, to: vid.id });
                CM.renderAll();
                const origCreate = API.createVideoTask;
                API.createVideoTask = async () => { throw new Error('MOCK_STOP'); };
                try {
                    // 审核中 → 阻止
                    MaterialLib._upsert({ id: 'maas_test_1', status: 'processing' });
                    document.dispatchEvent(new CustomEvent('aistudio-material-cache'));
                    await CM.generateVideo(vid.id);
                    r.blockProcessing = (vid.data.error || '').includes('审核中') && vid.data.status === 'idle';
                    // 审核失败 → 阻止
                    MaterialLib._upsert({ id: 'maas_test_1', status: 'failed' });
                    document.dispatchEvent(new CustomEvent('aistudio-material-cache'));
                    await CM.generateVideo(vid.id);
                    r.blockFailed = (vid.data.error || '').includes('审核失败') && vid.data.status === 'idle';
                    // 未入库（无 assetId）→ 阻止
                    mat.data.assetId = '';
                    await CM.generateVideo(vid.id);
                    r.blockNoAsset = (vid.data.error || '').includes('尚未完成入库');
                    // 审核通过 → 通过校验（到达 createTask，报 MOCK_STOP 而非审核错）
                    mat.data.assetId = 'maas_test_1';
                    MaterialLib._upsert({ id: 'maas_test_1', status: 'active' });
                    document.dispatchEvent(new CustomEvent('aistudio-material-cache'));
                    await CM.generateVideo(vid.id);
                    r.passActive = (vid.data.error || '').includes('MOCK_STOP') && !(vid.data.error || '').includes('审核');
                } finally {
                    API.createVideoTask = origCreate;
                    MaterialLib.uploadFile = origUpload;
                }
            } finally {
                MaterialLib.uploadFile = origUpload;
            }
            return r;
        })()`);
    } catch (e) { err = String(e && e.message || e); }
    if (err) out(`ERROR material-block: ${err}`);
    ['ruleAllowsMaterial','materialCreated','edgeCreated','imageKept','uploadStarted','uploaded',
     'badgeProcessing','badgeActiveEvent','imageBadgeUntouched',
     'blockProcessing','blockFailed','blockNoAsset','passActive']
        .forEach(k => { if (r) assert(`material.${k}`, r[k], r[k]); });

    // ---------- 控制台错误 ----------
    const realErrors = consoleErrors.filter(m => !/net::|ERR_|Failed to load resource|火山|API|401|403|404|Upload|uguu|MOCK_STOP/i.test(m));
    assert('noRealConsoleErrors', realErrors.length === 0, realErrors.slice(0, 3));

    out(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    flush();
    app.exit(failures === 0 ? 0 : 1);
});
