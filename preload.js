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
  // 画布项目磁盘持久化（项目 JSON 可能远超 localStorage 配额，落盘 userData/canvas-projects/）
  saveCanvasProject: (id, json) => ipcRenderer.invoke('canvas:save-project', { id, json }),
  loadCanvasProject: (id) => ipcRenderer.invoke('canvas:load-project', { id }),
  deleteCanvasProject: (id) => ipcRenderer.invoke('canvas:delete-project', { id }),
  // 注册码（一码一机）：授权状态查询 / 激活
  getLicenseState: () => ipcRenderer.invoke('license:get-state'),
  activateLicense: (code) => ipcRenderer.invoke('license:activate', code),
  // 本地多用户账号：会话查询 / 注册 / 登录 / 退出 / 注销（删除账号与工作空间）
  authSession: () => ipcRenderer.invoke('auth:session'),
  authRegister: (username, password) => ipcRenderer.invoke('auth:register', { username, password }),
  authLogin: (username, password, remember) => ipcRenderer.invoke('auth:login', { username, password, remember: !!remember }),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authDeleteAccount: () => ipcRenderer.invoke('auth:delete')
});
