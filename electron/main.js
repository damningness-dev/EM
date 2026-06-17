const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const isDev = !app.isPackaged;

// ─── 로컬 데이터 저장 ──────────────────────────────────────────────────────────

function getDataPath() {
  return path.join(app.getPath('userData'), 'em-data.json');
}

function loadData() {
  const p = getDataPath();
  if (!fs.existsSync(p)) {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(getDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function newId() {
  return crypto.randomUUID();
}

// ─── 윈도우 생성 ────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: '환경 모니터링 관리 시스템',
    backgroundColor: '#f3f4f6',
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.removeMenu();
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC 핸들러 ────────────────────────────────────────────────────────────────

function registerHandlers() {

  // ── 교정 ──
  ipcMain.handle('calibration:getAll', () => {
    return loadData().calibration;
  });

  ipcMain.handle('calibration:upsert', (_e, item) => {
    const data = loadData();
    if (item.id) {
      const idx = data.calibration.findIndex(c => c.id === item.id);
      if (idx >= 0) data.calibration[idx] = item;
      else data.calibration.push(item);
    } else {
      item.id = newId();
      data.calibration.push(item);
    }
    saveData(data);
    return item;
  });

  ipcMain.handle('calibration:delete', (_e, id) => {
    const data = loadData();
    data.calibration = data.calibration.filter(c => c.id !== id);
    saveData(data);
  });

  // ── 모니터링 구역 ──
  ipcMain.handle('zones:getAll', () => {
    return loadData().zones;
  });

  ipcMain.handle('zones:upsert', (_e, zone) => {
    const data = loadData();
    if (zone.id) {
      const idx = data.zones.findIndex(z => z.id === zone.id);
      if (idx >= 0) data.zones[idx] = zone;
      else data.zones.push(zone);
    } else {
      zone.id = newId();
      data.zones.push(zone);
    }
    saveData(data);
    return zone;
  });

  ipcMain.handle('zones:delete', (_e, id) => {
    const data = loadData();
    data.zones = data.zones.filter(z => z.id !== id);
    // 해당 구역 모니터링 데이터도 삭제
    Object.keys(data.monitoringData).forEach(key => {
      if (key.startsWith(`${id}_`)) delete data.monitoringData[key];
    });
    saveData(data);
  });

  // ── 월별 모니터링 데이터 ──
  ipcMain.handle('monitoring:getMonth', (_e, year, month) => {
    const data = loadData();
    const prefix = `${year}_${month}_`;
    const result = {};
    Object.entries(data.monitoringData).forEach(([key, val]) => {
      if (key.startsWith(prefix)) {
        const zoneId = key.slice(prefix.length);
        result[zoneId] = val;
      }
    });
    return result;
  });

  ipcMain.handle('monitoring:getYear', (_e, year) => {
    const data = loadData();
    const prefix = `${year}_`;
    const result = {};
    Object.entries(data.monitoringData).forEach(([key, val]) => {
      if (key.startsWith(prefix)) {
        // key: year_month_zoneId → result key: zoneId_month
        const rest = key.slice(prefix.length);              // month_zoneId
        const underIdx = rest.indexOf('_');
        const month = rest.slice(0, underIdx);
        const zoneId = rest.slice(underIdx + 1);
        result[`${zoneId}_${month}`] = val;
      }
    });
    return result;
  });

  ipcMain.handle('monitoring:upsert', (_e, entry) => {
    const data = loadData();
    const key = `${entry.year}_${entry.month}_${entry.zone_id}`;
    data.monitoringData[key] = { ...entry, id: key };
    saveData(data);
    return data.monitoringData[key];
  });

  // ── 연간 계획 ──
  ipcMain.handle('annualPlan:getYear', (_e, year) => {
    const data = loadData();
    const prefix = `${year}_`;
    const result = {};
    Object.entries(data.annualPlan).forEach(([key, val]) => {
      if (key.startsWith(prefix)) {
        // key: year_ahuName_month → result key: ahuName_month
        const rest = key.slice(prefix.length);
        result[rest] = val;
      }
    });
    return result;
  });

  ipcMain.handle('annualPlan:upsert', (_e, entry) => {
    const data = loadData();
    const key = `${entry.year}_${entry.ahu_name}_${entry.month}`;
    data.annualPlan[key] = { ...entry, id: key };
    saveData(data);
    return data.annualPlan[key];
  });

  // ── 초기 데이터 시딩 ──
  ipcMain.handle('data:seed', (_e, calibrationData, zonesData) => {
    const data = loadData();
    if (data.calibration.length === 0) {
      data.calibration = calibrationData.map((c, i) => ({
        id: newId(),
        no: c.no, sn: c.sn, cert_no: c.certNo,
        calib_date: c.calibDate || null,
        next_calib_date: c.nextCalibDate || null,
        name: c.name, note: c.note, sort_order: i,
      }));
    }
    if (data.zones.length === 0) {
      data.zones = zonesData.map((z, i) => ({
        id: newId(),
        name: z.name, grade: z.grade, category: z.category, sort_order: i,
      }));
    }
    saveData(data);
  });

  // ── 데이터 경로 조회 (디버그용) ──
  ipcMain.handle('data:getPath', () => getDataPath());
}
