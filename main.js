const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const http = require('http');

/**
 * 下载远程文件到本地硬盘
 * @param {string} url - 远程资源地址（http/https 或 blob:）
 * @returns {Promise<Buffer>}
 */
function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    // blob: 链接无法在 Node 中直接拉取，交给渲染进程处理
    if (!/^https?:\/\//i.test(url)) {
      return reject(new Error('非 http(s) 地址，无法在本地保存'));
    }
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'Accept': '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        return downloadToBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const ct = (res.headers['content-type'] || '').toLowerCase();
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), contentType: ct }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('下载超时')); });
  });
}

// 保存目录：~/Documents/AI Studio/history/{视频|图片}
function getHistoryDir(folder) {
  const base = path.join(app.getPath('documents'), 'AI Studio', 'history');
  const dir = path.join(base, folder || '默认');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 历史目录磁盘配额（MB）：超过后自动删除最旧文件，防止长期使用写爆磁盘
const HISTORY_MAX_MB = 500;

/**
 * 统计目录下所有文件总大小（MB）
 */
async function dirTotalMB(dir) {
  let total = 0;
  try {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      try {
        const st = await fsp.stat(path.join(dir, f));
        if (st.isFile()) total += st.size;
      } catch { /* 忽略单个文件读取失败 */ }
    }
  } catch { /* 目录不存在时按 0 处理 */ }
  return total / 1024 / 1024;
}

/**
 * 目录空间不足时删除最旧的文件，直到总量低于上限（至少保留一个）
 */
async function enforceHistoryQuota(dir) {
  let total = await dirTotalMB(dir);
  if (total <= HISTORY_MAX_MB) return;
  try {
    const files = (await fsp.readdir(dir))
      .map(f => ({ f, p: path.join(dir, f) }))
      .filter(entry => fs.statSync(entry.p).isFile());
    // 按修改时间升序（最旧在前）
    files.sort((a, b) => fs.statSync(a.p).mtimeMs - fs.statSync(b.p).mtimeMs);
    while (total > HISTORY_MAX_MB && files.length > 1) {
      const oldest = files.shift();
      try {
        const sz = fs.statSync(oldest.p).size / 1024 / 1024;
        await fsp.unlink(oldest.p);
        total -= sz;
        console.log(`[history:save] 磁盘配额：删除最旧文件 ${oldest.f} (${sz.toFixed(1)}MB)`);
      } catch (e) {
        console.warn(`[history:save] 删除失败 ${oldest.f}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[history:save] 配额清理异常:', e.message);
  }
}

// 单实例锁 — 防止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // 有人试图启动第二个实例时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// 保持窗口引用
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    show: true,
  title: 'AI Studio - AI创作工坊',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  // 加载本地 index.html
  mainWindow.loadFile('index.html');

  // 确保窗口显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 开发时如需调试，取消下面这行注释
  // mainWindow.webContents.openDevTools();

  // 拦截外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 应用菜单
const menuTemplate = [
  {
    label: '文件',
    submenu: [
      { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
    ]
  },
  {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ]
  },
  {
    label: '视图',
    submenu: [
      { role: 'reload', label: '刷新' },
      { role: 'forceReload', label: '强制刷新' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '重置缩放' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' }
    ]
  },
  {
    label: '帮助',
    submenu: [
      {
        label: '关于 AI Studio',
        click: () => {
          const { dialog } = require('electron');
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '关于 AI Studio',
            message: 'AI Studio - AI创作工坊',
            detail: '版本 V1.0.19\n湖北生而为一科技有限公司'
          });
        }
      }
    ]
  }
];

app.whenReady().then(() => {
  // 本地持久化：把远程视频/图片保存到本地 history 目录，返回本地 file:// 路径
  ipcMain.handle('history:save', async (event, { url, folder, filename }) => {
    try {
      const safeFolder = String(folder || '默认').replace(/[\\/:*?"<>|]/g, '_');
      const dir = getHistoryDir(safeFolder);
      const dl = await downloadToBuffer(url);
      // 根据内容类型推断扩展名，fallback 到请求时的扩展名
      const ct = dl.contentType || '';
      let ext = '';
      if (ct.includes('mp4')) ext = '.mp4';
      else if (ct.includes('webm')) ext = '.webm';
      else if (ct.includes('quicktime') || ct.includes('mov')) ext = '.mov';
      else if (ct.includes('png')) ext = '.png';
      else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
      else if (ct.includes('webp')) ext = '.webp';
      else if (ct.includes('gif')) ext = '.gif';
      else {
        const m = String(filename || '').match(/\.(\w+)$/);
        ext = m ? '.' + m[1] : '';
      }
      const safeName = String(filename || Date.now())
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.[^.]+$/, '')
        .slice(-60) + ext;
      const localPath = path.join(dir, safeName);
      await fsp.writeFile(localPath, dl.buf);
      // 写入后执行磁盘配额清理（超 500MB 删最旧文件）
      await enforceHistoryQuota(dir);
      return { ok: true, path: localPath, fileUrl: 'file://' + localPath };
    } catch (err) {
      console.error('[history:save] 保存失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
