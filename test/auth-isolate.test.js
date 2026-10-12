/**
 * auth-isolate.test.js — 多用户工作空间隔离（渲染层）端到端测试
 * 覆盖：
 *  1. 测试环境下登录门禁自动禁用（Auth.ready 立即放行、遮罩隐藏、App 正常初始化）
 *  2. ScopedStore 键前缀规则：未登录=原键名（向后兼容），登录= u:<uid>: 前缀
 *  3. 双账号数据互不可见（写 A → 切 B 不可见 → 切回 A 可见）
 *  4. 关键模块键全部走命名空间（config/material/agent/canvas/timeline）
 * 运行：electron.exe --no-sandbox --disable-gpu --enable-unsafe-swiftshader test\auth-isolate.test.js
 * 结果写 test/auth-isolate.result.txt
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'aistudio-auth-isolate-test'));

const RESULT_FILE = path.join(__dirname, 'auth-isolate.result.txt');
const lines = [];
const flush = () => { try { fs.writeFileSync(RESULT_FILE, lines.join('\n'), 'utf8'); } catch (e) {} };
const out = (s) => { lines.push(s); flush(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(name, cond, extra) {
    if (cond) out(`PASS ${name}`);
    else { failures++; out(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1400, height: 900,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);

    // ---------- 1. 门禁在测试环境自动禁用 ----------
    const gate = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        r.hasScoped = typeof ScopedStore !== 'undefined';
        r.hasAuth = typeof Auth !== 'undefined' && !!Auth.ready;
        const t = await Promise.race([Auth.ready.then(() => 'resolved'), new Promise(res => setTimeout(() => res('timeout'), 3000))]);
        r.readyResolved = t === 'resolved';
        r.overlayHidden = document.getElementById('authOverlay').classList.contains('hidden');
        r.appInited = typeof App === 'object' && !!document.getElementById('settingsBtn');
        return r;
    })()`);
    assert('渲染层加载了 ScopedStore', gate.hasScoped);
    assert('渲染层加载了 Auth 门禁', gate.hasAuth);
    assert('测试环境 Auth.ready 立即放行', gate.readyResolved);
    assert('登录遮罩保持隐藏', gate.overlayHidden);
    assert('App 正常初始化（不受门禁阻塞）', gate.appInited);

    // ---------- 2. 键前缀规则 ----------
    const prefix = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        ScopedStore.setUid(null);
        r.nullUid = ScopedStore.key('opc_api_keys');
        ScopedStore.setUid('a1b2c3d4e5f6a7b8c9d0e1f2');
        r.scoped = ScopedStore.key('opc_api_keys');
        r.uidProp = ScopedStore.uid;
        ScopedStore.setUid(null);
        return r;
    })()`);
    assert('未登录：键名保持原样（向后兼容）', prefix.nullUid === 'opc_api_keys', prefix.nullUid);
    assert('登录后：键名带 u:<uid>: 前缀', prefix.scoped === 'u:a1b2c3d4e5f6a7b8c9d0e1f2:opc_api_keys', prefix.scoped);

    // ---------- 3. 双账号数据互不可见 ----------
    const isolation = await win.webContents.executeJavaScript(`(async () => {
        const UA = 'a1a1a1a1a1a1a1a1a1a1a1a1', UB = 'b2b2b2b2b2b2b2b2b2b2b2b2';
        const K = 'opc_test_workspace_probe';
        ScopedStore.setUid(UA);
        localStorage.setItem(ScopedStore.key(K), 'A-data');
        ScopedStore.setUid(UB);
        const bSees = localStorage.getItem(ScopedStore.key(K));
        localStorage.setItem(ScopedStore.key(K), 'B-data');
        ScopedStore.setUid(UA);
        const aSees = localStorage.getItem(ScopedStore.key(K));
        localStorage.removeItem(ScopedStore.key(K));
        ScopedStore.setUid(null);
        return { aSees, bSees };
    })()`);
    assert('B 账号看不到 A 的数据', isolation.bSees === null, isolation.bSees);
    assert('切回 A 后数据完整', isolation.aSees === 'A-data', isolation.aSees);

    // ---------- 4. 各模块键走命名空间 ----------
    const keys = await win.webContents.executeJavaScript(`(() => {
        const r = {};
        ScopedStore.setUid('test0test0test0test0test0t');
        r.cfgPlatform = Config.STORAGE_KEYS.PLATFORM;
        r.cfgHistory = Config.STORAGE_KEYS.HISTORY;
        r.material = MaterialLib.STORAGE_KEY;
        r.agent = AgentModule.STORE_KEY;
        r.canvasProjects = CanvasModule.PROJECTS_KEY;
        r.canvasProject = CanvasModule._projectKey('p1');
        r.timeline = TimelineModule.STORAGE_KEY;
        ScopedStore.setUid(null);
        return r;
    })()`);
    const P = 'u:test0test0test0test0test0t:';
    assert('config 键走命名空间', keys.cfgPlatform === P + 'opc_platform', keys.cfgPlatform);
    assert('history 键走命名空间', keys.cfgHistory === P + 'opc_history', keys.cfgHistory);
    assert('material 键走命名空间', keys.material === P + 'aistudio_material_library', keys.material);
    assert('agent 会话键走命名空间', keys.agent === P + 'aistudio_agent_sessions_v1', keys.agent);
    assert('canvas 项目索引键走命名空间', keys.canvasProjects === P + 'aistudio_canvas_projects', keys.canvasProjects);
    assert('canvas 项目数据键走命名空间', keys.canvasProject === P + 'aistudio_canvas_project_p1', keys.canvasProject);
    assert('timeline 键走命名空间', keys.timeline === P + 'h3-timeline-draft-v1', keys.timeline);

    out(`\n==== auth-isolate.test.js: ${lines.filter(l => l.startsWith('PASS')).length} passed, ${failures} failed ====`);
    app.exit(failures ? 1 : 0);
}).catch((e) => {
    out('FATAL ' + (e && e.stack || e));
    flush();
    app.exit(1);
});
