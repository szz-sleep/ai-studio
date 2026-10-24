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

function registerCanvasPersistIpc(ipcMain, app, auth, fsSync, fsp) {
  function canvasProjectDir() {
    const scope = String((auth && auth.currentUid()) || 'shared').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(app.getPath('userData'), 'canvas-projects', scope);
    try { fsSync.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    return dir;
  }
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
