const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;

// ─── ASAR 업데이터 ─────────────────────────────────────────────────────────────

const META_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-meta.json';
const ASAR_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-patch.asar';

let mainWin = null;

function sendStatus(status) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('update:status', status);
  }
}

function getUpdatePath() {
  return path.join(app.getPath('userData'), 'app.asar.update');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'em-updater/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve(httpGet(res.headers.location));
      } else {
        resolve(res);
      }
    }).on('error', reject);
  });
}

async function fetchJSON(url) {
  const res = await httpGet(url);
  if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    res.on('error', reject);
  });
}

async function downloadAsar(url, dest) {
  const res = await httpGet(url);
  if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }

  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0;
  let lastEmitTime = Date.now();
  let lastEmitBytes = 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);

  return new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      hash.update(chunk);
      out.write(chunk);

      const now = Date.now();
      const elapsed = now - lastEmitTime;
      if (elapsed >= 300) {
        const speed = Math.round((downloaded - lastEmitBytes) / (elapsed / 1000) / 1024);
        lastEmitTime = now;
        lastEmitBytes = downloaded;
        sendStatus({
          type: 'downloading',
          percent: total > 0 ? Math.round(downloaded / total * 100) : 0,
          transferred: Math.round(downloaded / 1024 / 1024 * 10) / 10,
          total: Math.round(total / 1024 / 1024 * 10) / 10,
          speed,
        });
      }
    });

    res.on('end', () => { out.end(() => resolve(hash.digest('hex'))); });

    const cleanup = (err) => { out.destroy(); try { fs.unlinkSync(dest); } catch {} reject(err); };
    res.on('error', cleanup);
    out.on('error', cleanup);
  });
}

async function checkForUpdate() {
  sendStatus({ type: 'checking' });
  try {
    const meta = await fetchJSON(META_URL);
    if (meta.version === app.getVersion()) {
      sendStatus({ type: 'latest' });
    } else {
      sendStatus({ type: 'available', version: meta.version });
    }
  } catch (err) {
    // 404 = 아직 게시된 릴리즈에 app-meta.json이 없음 (정상, 조용히 무시)
    if (err.message.startsWith('HTTP 404')) return;
    sendStatus({ type: 'error', message: `업데이트 확인 실패: ${err.message}` });
  }
}

async function downloadUpdate() {
  const dest = getUpdatePath();
  try {
    const meta = await fetchJSON(META_URL);
    const sha256 = await downloadAsar(ASAR_URL, dest);

    if (meta.sha256 && sha256 !== meta.sha256) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error('파일 검증 실패 (체크섬 불일치)');
    }

    sendStatus({ type: 'downloaded', version: meta.version });
  } catch (err) {
    try { fs.unlinkSync(dest); } catch {}
    sendStatus({ type: 'error', message: err.message });
  }
}

function applyUpdateAndRestart() {
  const updateSrc = getUpdatePath();
  const asarDest = path.join(process.resourcesPath, 'app.asar');
  const exePath = process.execPath;

  if (!fs.existsSync(updateSrc)) {
    sendStatus({ type: 'error', message: '업데이트 파일이 없습니다. 다시 다운로드해 주세요.' });
    return;
  }

  if (process.platform === 'win32') {
    const tempDir = app.getPath('temp');
    // 한글 경로를 JSON에 UTF-8로 저장 (PS1 스크립트에 직접 넣으면 인코딩 깨짐)
    const configPath = path.join(tempDir, 'em-update-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ src: updateSrc, dst: asarDest, exe: exePath }), 'utf-8');

    // PS1 스크립트는 ASCII만 사용 — 한글 경로는 런타임에 JSON에서 읽음
    const esc = (p) => p.replace(/'/g, "''");
    const pid = process.pid;
    const script = [
      `$cfg = [System.IO.File]::ReadAllText('${esc(configPath)}', [System.Text.Encoding]::UTF8) | ConvertFrom-Json`,
      // 프로세스가 완전히 종료될 때까지 대기 (고정 sleep 대신 PID로 정확히 감지)
      `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      `if ($proc) { $proc.WaitForExit(15000) }`,
      `Start-Sleep -Milliseconds 500`,
      `try {`,
      `  Copy-Item -Path $cfg.src -Destination $cfg.dst -Force`,
      `  Remove-Item -Path $cfg.src -Force -ErrorAction SilentlyContinue`,
      `  Remove-Item -Path '${esc(configPath)}' -Force -ErrorAction SilentlyContinue`,
      `  Start-Process -FilePath $cfg.exe`,
      `} catch {`,
      `  Add-Type -AssemblyName System.Windows.Forms`,
      `  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Update Error')`,
      `}`,
    ].join('\r\n');

    const psPath = path.join(tempDir, 'em-update.ps1');
    fs.writeFileSync(psPath, script, 'utf-8');

    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-NonInteractive',
      '-File', psPath,
    ], { detached: true, stdio: 'ignore' }).unref();
  }

  app.quit();
}

function setupAsarUpdater(win) {
  if (isDev) return;
  mainWin = win;
  setTimeout(checkForUpdate, 5000);
}

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

  win.webContents.on('did-finish-load', () => {
    setupAsarUpdater(win);
  });
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

  // ── 업데이트 ──
  ipcMain.handle('update:check', checkForUpdate);
  ipcMain.handle('update:download', downloadUpdate);
  ipcMain.handle('update:install', applyUpdateAndRestart);

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
        result[key.slice(prefix.length)] = val;
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
        const rest = key.slice(prefix.length);
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
        result[key.slice(prefix.length)] = val;
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

  ipcMain.handle('data:getPath', () => getDataPath());
}
