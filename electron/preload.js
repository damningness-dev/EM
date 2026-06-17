const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 데이터 CRUD
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // 업데이트: 상태 이벤트 수신
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, status) => callback(status));
    return () => ipcRenderer.removeAllListeners('update:status');
  },
});
