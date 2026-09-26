const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // 保存远程资源到本地历史目录，返回 { ok, path, fileUrl } 或 { ok:false, error }
  saveToLocal: (payload) => ipcRenderer.invoke('history:save', payload),
  saveHistoryVideo: (payload) => ipcRenderer.invoke('history:save-video-bytes', payload),
  // 抽取视频末帧（30 秒两段生成的衔接用），返回 { ok, dataUrl }
  extractLastFrame: (payload) => ipcRenderer.invoke('video:extract-last-frame', payload),
  // 拼接多段视频并落盘，返回 { ok, path, fileUrl }
  concatVideos: (payload) => ipcRenderer.invoke('video:concat', payload),
  // 后处理能力探测，返回 { ok, path }
  compressTimelineVideo: (payload) => ipcRenderer.invoke('timeline:compress-video', payload),
  cancelTimelineCompression: (id) => ipcRenderer.send('timeline:cancel-compression', id),
  ffmpegAvailable: () => ipcRenderer.invoke('video:ffmpeg-available')
});
