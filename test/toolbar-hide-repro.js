// 复现：固定模式启动 → 取消固定 → 自动隐藏 → 鼠标移到顶部能否唤出
const { app, BrowserWindow } = require('electron');
const path = require('path'); const os = require('os');
app.setPath('userData', path.join(os.tmpdir(), 'aistudio-tb-test'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);
    // 预置：工具栏固定模式（模拟用户上次会话点了图钉）
    await win.webContents.executeJavaScript(`(() => {
        CanvasModule._settings.toolbarPin = true;
        CanvasModule._saveSettings();
        return localStorage.getItem(CanvasModule._settingsKey ? CanvasModule._settingsKey : 'canvas_settings');
    })()`);
    // 模拟重启：重载页面，让 _bindToolbarAutoHide 以 pin=true 完成一次性绑定
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1500);
    const r = await win.webContents.executeJavaScript(`(async () => {
        const sleep2 = ms => new Promise(r => setTimeout(r, ms));
        const panel = document.getElementById('tab-canvas');
        // 切到画布标签
        const tabBtn = document.querySelector('[data-tab="canvas"]');
        if (tabBtn) tabBtn.click();
        await sleep2(300);
        const out = {};
        out.pinAtStartup = CanvasModule._settings.toolbarPin;
        // 取消固定 → show + scheduleHide
        document.getElementById('canvasToolbarPinBtn').click();
        out.pinAfterUnpin = CanvasModule._settings.toolbarPin;
        await sleep2(2400);
        out.hiddenAfterUnpin = panel.classList.contains('toolbar-visible') === false;
        // 鼠标移到面板顶部 → 应唤出
        const rect = panel.getBoundingClientRect();
        const ev = new MouseEvent('mousemove', { bubbles: true, clientY: rect.top + 30, clientX: rect.left + 300 });
        Object.defineProperty(ev, 'target', { value: document.getElementById('canvasViewport') });
        panel.dispatchEvent(ev);
        out.showAfterTopHover = panel.classList.contains('toolbar-visible');
        return out;
    })()`);
    console.log(JSON.stringify(r, null, 2));
    app.quit();
});
