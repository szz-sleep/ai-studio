const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

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

// ============ 视频后处理（30 秒 = 两段 15 秒生成后拼接） ============

/**
 * 解析内置 ffmpeg 可执行文件路径。
 * @ffmpeg-installer 的子包只携带二进制、没有 JS 入口，需自行拼路径；
 * 打包后二进制被解到 app.asar.unpacked，路径要做一次映射。
 * @returns {string|null}
 */
function resolveFfmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // arm64 机器上没有原生包时回退到 x64（macOS 可经 Rosetta 运行）
  const suffixes = [`${process.platform}-${process.arch}`, `${process.platform}-x64`];
  const bases = [__dirname, __dirname.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked')];
  for (const suffix of suffixes) {
    const rel = path.join('node_modules', '@ffmpeg-installer', suffix, exe);
    for (const base of bases) {
      const candidate = path.join(base, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 执行 ffmpeg，成功返回 stderr 文本，失败抛出带末行日志的错误
 * @param {string[]} args
 * @param {{timeoutMs?:number}} [opts]
 */
function runFfmpeg(args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpegPath();
    if (!bin) return reject(new Error('未找到内置 ffmpeg，无法完成后处理'));
    const child = spawn(bin, args, cwd ? { windowsHide: true, cwd } : { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      reject(new Error('视频后处理超时'));
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // 只保留尾部，避免长任务日志撑爆内存
      if (stderr.length > 30000) stderr = stderr.slice(-10000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('ffmpeg 启动失败: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stderr);
      const tail = stderr.trim().split('\n').pop() || '';
      reject(new Error(`ffmpeg 处理失败(退出码 ${code}): ${tail}`));
    });
  });
}

/** 创建一次性临时工作目录 */
function makeTmpDir(tag) {
  const dir = path.join(os.tmpdir(), `ai-studio-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清理临时目录（失败不影响主流程） */
function cleanupTmpDir(dir) {
  fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* 忽略清理失败 */ });
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
            detail: '版本 V1.0.22\n湖北生而为一科技有限公司'
          });
        }
      }
    ]
  }
];

app.whenReady().then(() => {
  ipcMain.handle('history:save-video-bytes', async (event, { bytes, filename }) => {
    try {
      const data = Buffer.from(bytes);
      if (!data.length || data.length > 200 * 1024 * 1024) throw new Error('视频大小超出本地历史记录限制');
      const name = String(filename || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      if (!name) throw new Error('无效的任务文件名');
      const dir = getHistoryDir('视频');
      const localPath = path.join(dir, name + '.mp4');
      await fsp.writeFile(localPath, data);
      await enforceHistoryQuota(dir);
      return { ok: true, path: localPath, fileUrl: 'file://' + localPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
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

  const timelineCompressions = new Map();
  ipcMain.on('timeline:cancel-compression', (event, id) => {
    const entry = timelineCompressions.get(id);
    if (entry && entry.sender === event.sender) entry.child?.kill('SIGKILL');
    if (entry && entry.sender === event.sender) entry.cancelled = true;
  });
  ipcMain.handle('timeline:compress-video', async (event, { id, bytes, name }) => {
    if (typeof id !== 'string' || !/^upload-\d+$/.test(id) ||
        !bytes || bytes.byteLength < 1 || bytes.byteLength > 512 * 1024 * 1024 ||
        !resolveFfmpegPath() || timelineCompressions.has(id)) {
      return { ok: false, error: '视频压缩不可用或文件超过 512 MB' };
    }
    const entry = { sender: event.sender, child: null, cancelled: false };
    timelineCompressions.set(id, entry);
    const tmp = makeTmpDir('timeline-upload');
    try {
      const input = path.join(tmp, 'input' + (path.extname(String(name || '')).match(/^\.[a-z0-9]{1,8}$/i)?.[0] || '.mp4'));
      const output = path.join(tmp, 'output.mp4');
      await fsp.writeFile(input, Buffer.from(bytes));
      if (entry.cancelled) return { ok: false, cancelled: true };
      await new Promise((resolve, reject) => {
        const child = spawn(resolveFfmpegPath(), [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
          '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1200k', '-maxrate', '1400k', '-bufsize', '2800k',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output
        ], { windowsHide: true });
        entry.child = child;
        if (entry.cancelled) child.kill('SIGKILL');
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
        child.on('error', reject);
        child.on('close', code => {
          clearTimeout(timer);
          if (entry.cancelled) reject(new Error('已取消'));
          else if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `视频压缩失败 (${code})`));
        });
      });
      if (entry.cancelled) return { ok: false, cancelled: true };
      const compressed = await fsp.readFile(output);
      return { ok: true, bytes: compressed, smaller: compressed.length < bytes.byteLength };
    } catch (error) {
      return { ok: false, cancelled: entry.cancelled, error: error.message };
    } finally {
      timelineCompressions.delete(id);
      cleanupTmpDir(tmp);
    }
  });

  // 后处理能力探测：渲染层据此决定 30 秒拼接能否执行
  ipcMain.handle('video:ffmpeg-available', () => {
    const p = resolveFfmpegPath();
    return { ok: !!p, path: p || null };
  });

  // 抽取视频末帧：30 秒两段生成时，用它把第二段接在第一时间结尾的画面上
  ipcMain.handle('video:extract-last-frame', async (event, { url }) => {
    const tmp = makeTmpDir('frame');
    try {
      if (!resolveFfmpegPath()) throw new Error('未找到内置 ffmpeg，无法抽取衔接帧');
      const dl = await downloadToBuffer(url);
      const inPath = path.join(tmp, 'src.mp4');
      await fsp.writeFile(inPath, dl.buf);

      const outPath = path.join(tmp, 'last.jpg');
      // -sseof 从结尾前若干秒起解码，-update 1 让每帧覆盖同一文件，最终留下的就是末帧
      const seeks = [['-0.5'], ['-1'], ['-2']];
      let ok = false;
      for (const [offset] of seeks) {
        try {
          await runFfmpeg(['-y', '-sseof', offset, '-i', inPath, '-update', '1', '-q:v', '2', outPath], { timeoutMs: 120000 });
          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) { ok = true; break; }
        } catch { /* 换更早的起点重试 */ }
      }
      if (!ok) throw new Error('无法从首段视频中抽取衔接帧');

      const buf = await fsp.readFile(outPath);
      console.log(`[video:extract-last-frame] 衔接帧已提取 (${(buf.length / 1024).toFixed(1)}KB)`);
      return { ok: true, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64') };
    } catch (err) {
      console.error('[video:extract-last-frame] 失败:', err.message);
      return { ok: false, error: err.message };
    } finally {
      cleanupTmpDir(tmp);
    }
  });

  // 拼接多段视频为一个文件，并落盘到历史目录
  ipcMain.handle('video:concat', async (event, { urls, folder, filename }) => {
    const tmp = makeTmpDir('concat');
    try {
      if (!Array.isArray(urls) || urls.length < 2) throw new Error('至少需要两段视频才能拼接');
      if (!resolveFfmpegPath()) throw new Error('未找到内置 ffmpeg，无法拼接视频');

      const parts = [];
      for (let i = 0; i < urls.length; i++) {
        const dl = await downloadToBuffer(urls[i]);
        const p = path.join(tmp, `part${i}.mp4`);
        await fsp.writeFile(p, dl.buf);
        parts.push(p);
      }

      const listPath = path.join(tmp, 'list.txt');
      // ⚠️ Windows 上 ffmpeg 的 concat demuxer 会把盘符开头的绝对路径（C:/...）误判成相对路径，
      // 再拼上清单所在目录，报 `Impossible to open 'C:/temp/c:/...'`，导致拼接必然失败。
      // 故清单内一律写「相对文件名」，并让 ffmpeg 以 tmp 为工作目录运行：
      // 相对名在 Windows 下按工作目录解析、在 POSIX 下按清单目录解析，两种规则都指向 tmp。
      const listBody = parts
        .map((p) => `file '${path.basename(p).replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n';
      await fsp.writeFile(listPath, listBody, 'utf8');

      const outPath = path.join(tmp, 'merged.mp4');
      let copied = false;
      try {
        // 同模型同参数的两段通常可直接无损串接（快、无画质损失）
        await runFfmpeg(
          ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'merged.mp4'],
          { timeoutMs: 300000, cwd: tmp }
        );
        copied = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      } catch (e) {
        console.warn('[video:concat] 无损拼接失败，转为重编码:', e.message);
      }
      if (!copied) {
        // 编码参数不一致时降级重编码，保证一定能出片
        await runFfmpeg([
          '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '192k', 'merged.mp4'
        ], { timeoutMs: 1800000, cwd: tmp });
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('拼接未产出有效文件');

      const dir = getHistoryDir(String(folder || '视频'));
      const safeName = String(filename || `ai-video-merged-${Date.now()}`)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.[^.]+$/, '')
        .slice(-60) + '.mp4';
      const finalPath = path.join(dir, safeName);
      await fsp.copyFile(outPath, finalPath);
      await enforceHistoryQuota(dir);
      console.log(`[video:concat] 已生成 ${safeName} (${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(1)}MB)`);
      return { ok: true, path: finalPath, fileUrl: 'file://' + finalPath };
    } catch (err) {
      console.error('[video:concat] 失败:', err.message);
      return { ok: false, error: err.message };
    } finally {
      cleanupTmpDir(tmp);
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
