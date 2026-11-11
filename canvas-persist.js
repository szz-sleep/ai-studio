/**
 * canvas-persist.js — 画布项目磁盘持久化（主进程侧）
 *
 * 项目 JSON（含节点内联媒体 base64）可能远超 localStorage 配额（约 5-10MB），
 * 落盘到 userData/canvas-projects/<账号|shared>/<projectId>.json，localStorage 只保留项目索引。
 *
 * 通道：
 *   canvas:save-project    { id, json } → { ok, error? }   原子写（tmp + rename）
 *   canvas:load-project    { id }       → string | null    不存在/失败返回 null（渲染层回退 localStorage）
 *   canvas:delete-project  { id }       → { ok, error? }
 */
const path = require('path');
const url = require('url');

function registerCanvasPersistIpc(ipcMain, app, fsSync, fsp) {
  function canvasProjectDir() {
    // 多用户账号体系已移除，统一落 shared（旧版按 uid 的子目录由主进程启动时迁移合并）
    const dir = path.join(app.getPath('userData'), 'canvas-projects', 'shared');
    try { fsSync.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    return dir;
  }

  // ===== 画布媒体落盘（base64 → 本地文件，项目 JSON 只存 file:// 路径） =====
  // 独立 media 目录，不复用 history 目录（history 有 500MB 配额会删最旧文件，会弄丢画布引用）
  function canvasMediaDir() {
    const dir = path.join(app.getPath('userData'), 'canvas-projects', 'media');
    try { fsSync.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    return dir;
  }

  const MEDIA_EXT_MAP = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  };

  ipcMain.handle('canvas:save-media', async (event, { dataUrl, url: httpUrl, kind }) => {
    try {
      let buf;
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
        if (!m) throw new Error('无效的 base64 data URL');
        buf = Buffer.from(m[2], 'base64');
        var mime = m[1];
      } else if (typeof httpUrl === 'string' && /^https?:\/\//i.test(httpUrl)) {
        // 远程结果（生成完成的视频/图片）下载落盘，避免临时 URL 过期后节点失效
        const lib = httpUrl.startsWith('https') ? require('https') : require('http');
        buf = await new Promise((resolve, reject) => {
          const get = (u) => {
            const req = lib.get(u, { headers: { 'Accept': '*/*' } }, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return get(res.headers.location);
              }
              if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
          };
          get(httpUrl);
        });
        var mime = '';
      } else {
        throw new Error('缺少 dataUrl 或 url 参数');
      }
      if (!buf || !buf.length) throw new Error('空媒体数据');
      if (buf.length > 512 * 1024 * 1024) throw new Error('媒体文件超过 512MB');
      const ext = (mime && MEDIA_EXT_MAP[mime]) ||
        (mime ? '.' + String(mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') : (kind === 'video' ? '.mp4' : '.png'));
      const name = `${String(kind || 'media').replace(/[^a-z0-9_-]/gi, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const p = path.join(canvasMediaDir(), name);
      await fsp.writeFile(p, buf);
      return { ok: true, path: p, fileUrl: url.pathToFileURL(p).toString() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  function canvasProjectPath(id) {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return safeId ? path.join(canvasProjectDir(), safeId + '.json') : null;
  }

  ipcMain.handle('canvas:save-project', async (event, { id, json }) => {
    try {
      const p = canvasProjectPath(id);
      if (!p) throw new Error('无效的项目ID');
      if (typeof json !== 'string' || !json) throw new Error('空项目数据');
      const tmp = p + '.tmp';
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, p); // 原子替换：中途断电不会留下半个文件
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('canvas:load-project', async (event, { id }) => {
    try {
      const p = canvasProjectPath(id);
      if (!p) return null;
      return await fsp.readFile(p, 'utf8');
    } catch { return null; }
  });

  ipcMain.handle('canvas:delete-project', async (event, { id }) => {
    try {
      const p = canvasProjectPath(id);
      if (p) await fsp.unlink(p).catch(() => {});
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { registerCanvasPersistIpc };
