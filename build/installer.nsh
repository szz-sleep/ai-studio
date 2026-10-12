; NSIS include for AI Studio
; NSIS 3.x Unicode mode handles CJK font rendering correctly by default
; SetFont is not valid inside a Function in NSIS 3.0.4.1, so we omit it.

!macro customInit
  ; NSIS 3.x Unicode already supports CJK characters properly.
  ; No custom font setup required.

  ; 强制清理残留进程，避免升级时弹「云镜AI Studio 无法关闭」：
  ; 主程序有窗口、安装器能优雅关闭；但无窗口的 agent-server.exe 后端若残留
  ; （历史版本杀不干净），会锁住 resources\agent-server\agent-server.exe。
  nsExec::Exec 'taskkill /F /IM agent-server.exe /T'
  Pop $R9
  nsExec::Exec 'taskkill /F /IM AIStudio.exe /T'
  Pop $R9
  Sleep 600
!macroend
