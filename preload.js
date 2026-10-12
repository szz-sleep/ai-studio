const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // 原生音频文件选择对话框，返回 { ok, name, ext, base64 } 或 { ok:false }
  pickAudio: () => ipcRenderer.invoke('dialog:pick-audio'),
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
  ffmpegAvailable: () => ipcRenderer.invoke('video:ffmpeg-available'),
  // 注册码（一码一机）：授权状态查询 / 激活
  getLicenseState: () => ipcRenderer.invoke('license:get-state'),
  activateLicense: (code) => ipcRenderer.invoke('license:activate', code),
  // 本地多用户账号：会话查询 / 注册 / 登录 / 退出
  authSession: () => ipcRenderer.invoke('auth:session'),
  authRegister: (username, password) => ipcRenderer.invoke('auth:register', { username, password }),
  authLogin: (username, password, remember) => ipcRenderer.invoke('auth:login', { username, password, remember: !!remember }),
  authLogout: () => ipcRenderer.invoke('auth:logout')
});
