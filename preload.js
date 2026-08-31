const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // 保存远程资源到本地历史目录，返回 { ok, path, fileUrl } 或 { ok:false, error }
  saveToLocal: (payload) => ipcRenderer.invoke('history:save', payload)
});
