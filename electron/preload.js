const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 데이터 CRUD
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // 업데이트: 상태 이벤트 수신
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, status) => callback(status));
    return () => ipcRenderer.removeAllListeners('update:status');
  },

  // 순서/그룹 관리 별도 창 (항상 위)
  openOrderManager: () => ipcRenderer.invoke('orderManager:open'),
  closeOrderManager: () => ipcRenderer.send('orderManager:close'),

  // 데이터 변경 알림 / 수신 (창 간 동기화)
  notifyDataChanged: () => ipcRenderer.send('app:dataChanged'),
  onDataChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:dataChanged', handler);
    return () => ipcRenderer.removeListener('app:dataChanged', handler);
  },

  // 공유 동기화 상태 이벤트 수신
  onSyncStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('sync:status', handler);
    return () => ipcRenderer.removeListener('sync:status', handler);
  },

  // 할일 알람 이벤트 수신 (인앱 팝업 표시용)
  onTodoAlarm: (callback) => {
    const handler = (_event, todo) => callback(todo);
    ipcRenderer.on('todo:alarm', handler);
    return () => ipcRenderer.removeListener('todo:alarm', handler);
  },
});
