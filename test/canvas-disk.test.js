/**
 * 画布项目磁盘持久化端到端测试（主进程注册真实 canvas:* handler）：
 *  A. _saveNow 落盘 → userData/canvas-projects/shared/<id>.json 存在
 *  B. 清掉 localStorage 副本后 _loadProject 仍能恢复 → 数据确实来自磁盘
 *  C. 内联媒体（base64 大字符串）跨会话保留
 * 运行：npx electron --no-sandbox --disable-gpu test/canvas-disk.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

app.setPath('userData', path.join(os.tmpdir(), 'aistudio-canvas-disk-test'));
const RESULT_FILE = path.join(__dirname, 'canvas-disk.result.txt');
const lines = [];
const out = (s) => { lines.push(s); try { fs.writeFileSync(RESULT_FILE, lines.join('\n')); } catch (e) {} };
let failures = 0;
const assert = (name, cond, extra) => {
    if (cond) out(`PASS ${name}`);
    else { failures++; out(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { registerCanvasPersistIpc } = require('../canvas-persist');
registerCanvasPersistIpc(ipcMain, app, { currentUid: () => null }, fs, fsp); // 未登录 → shared 目录

app.whenReady().then(async () => {
    try {
        // 干净起点：清掉上次运行残留的项目文件（userData 临时目录跨运行持久）
        fs.rmSync(path.join(app.getPath('userData'), 'canvas-projects'), { recursive: true, force: true });
        const win = new BrowserWindow({
            width: 1200, height: 800, show: false,
            webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        await win.loadFile(path.join(__dirname, '..', 'index.html'));
        await sleep(1200);
        // 清空画布项目索引后重新迁移，保证默认项目是全新空项目
        await win.webContents.executeJavaScript(`(async () => {
            const CM = (typeof CanvasModule !== 'undefined') ? CanvasModule : window.CanvasModule;
            localStorage.removeItem(CM.PROJECTS_KEY);
            localStorage.removeItem(CM.PROJECT_CURRENT_KEY);
            localStorage.removeItem('aistudio_canvas_v1');
            await CM._restore();
        })()`);
        await sleep(300);

        // 2MB 内联媒体，验证超 localStorage 常规单值体量的数据能落盘并恢复
        const BIG = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
        const r = await win.webContents.executeJavaScript(`(async () => {
            const r = {};
            const CM = (typeof CanvasModule !== 'undefined') ? CanvasModule : window.CanvasModule;
            if (!CM) throw new Error('CanvasModule not found');
            r.diskPersist = CM._diskPersist === true;

            // A. 造一个大画布并落盘
            const img = CM.addNode('image', 10, 10);
            img.data.url = ${JSON.stringify(BIG)};
            const pid = CM.currentProjectId;
            await CM._saveNow();
            r.saved = true;

            // 清掉 localStorage 副本（磁盘路径成功时本就不写 localStorage），强制下次从磁盘读
            localStorage.removeItem(CM._projectKey(pid));

            // B. 切走再切回（模拟重启后的载入）
            const p2 = await CM._createProject('disk-test-b');
            await CM._loadProject(pid);
            r.restoredNodeCount = CM.nodes.length;
            r.restoredUrlPrefix = (CM.nodes.find(n => n.id === img.id)?.data.url || '').slice(0, 22);
            r.currentOk = CM.currentProjectId === pid;
            return r;
        })()`).catch(e => ({ error: String(e && e.message || e) }));

        if (r.error) { failures++; out(`ERROR ${r.error}`); }
        else {
            // 磁盘文件确实存在
            const dir = path.join(app.getPath('userData'), 'canvas-projects', 'shared');
            const files = (await fsp.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'));
            assert('disk.persistAvailable', r.diskPersist === true, r.diskPersist);
            assert('disk.fileWritten', files.length >= 1, files);
            const raw = await fsp.readFile(path.join(dir, files[0]), 'utf8').catch(() => '');
            assert('disk.fileHasMedia', raw.includes('data:image/png;base64,AAAA'), raw.length);
            assert('disk.restored', r.restoredNodeCount === 1 && r.currentOk === true, r);
            assert('disk.mediaSurvived', (r.restoredUrlPrefix || '') === 'data:image/png;base64,', r.restoredUrlPrefix);
        }
    } catch (e) {
        out(`ERROR ${e && e.message || e}`);
    }
    out(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    app.exit(failures === 0 ? 0 : 1);
});
