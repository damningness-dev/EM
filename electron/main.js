const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const isDev = !app.isPackaged;

// ─── ASAR 업데이터 ─────────────────────────────────────────────────────────────

const META_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-meta.json';
const ASAR_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-patch.asar';

let mainWin = null;
let orderManagerWin = null;

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
  if (!fs.existsSync(updateSrc)) {
    sendStatus({ type: 'error', message: '업데이트 파일이 없습니다. 다시 다운로드해 주세요.' });
    return;
  }
  // Relaunch with --apply-update arg; the new instance applies the update before showing any UI.
  // This avoids the Windows Job Object problem (spawned scripts get killed with the parent).
  app.relaunch({ args: [`--apply-update=${updateSrc}`] });
  app.exit(0);
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
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data.groups) data.groups = [];
    if (!data.holidays) data.holidays = [];
    if (!data.completions) data.completions = [];
    if (!data.tempSchedules) data.tempSchedules = [];
    if (!data.blockedDates) data.blockedDates = [];
    return data;
  } catch {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(getDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function newId() {
  return crypto.randomUUID();
}

// ─── 공유 동기화 (GitHub Gist) ────────────────────────────────────────────────
// 일정 데이터(em-data.json)를 Gist에 업로드해 공유하고, 다른 PC는 주기적으로
// 내려받아 최신화한다. 업로드는 토큰이 있는 관리자만, 읽기는 토큰 없이 가능.

const GIST_FILE = 'em-data.json';

function syncConfigPath() {
  return path.join(app.getPath('userData'), 'sync-config.json');
}
function loadSyncConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(syncConfigPath(), 'utf-8'));
    return { gistId: '', token: '', autoSync: true, intervalMin: 5, lastSyncedAt: '', ...c };
  } catch {
    return { gistId: '', token: '', autoSync: true, intervalMin: 5, lastSyncedAt: '' };
  }
}
function saveSyncConfig(cfg) {
  try { fs.writeFileSync(syncConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8'); } catch { /* ignore */ }
}

function sendSyncStatus(status) {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('sync:status', status); });
}
function broadcastDataChanged() {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('app:dataChanged'); });
}

// HTTPS 요청 (GET/POST/PATCH + 선택적 인증 + 본문)
function ghRequest(method, apiUrl, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'User-Agent': 'em-sync/1.0', 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'token ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(out || '{}')); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Gist에서 데이터 파일 내용 + updated_at 조회 (1MB 초과 truncated면 raw_url로 재조회)
async function gistFetchData(gistId, token) {
  const g = await ghRequest('GET', `https://api.github.com/gists/${gistId}`, { token: token || undefined });
  const file = g.files && g.files[GIST_FILE];
  if (!file) throw new Error(`Gist에 ${GIST_FILE} 파일이 없습니다`);
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const res = await httpGet(file.raw_url);
    if (res.statusCode !== 200) { res.resume(); throw new Error(`raw HTTP ${res.statusCode}`); }
    content = await new Promise((resolve, reject) => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); res.on('error', reject);
    });
  }
  return { updatedAt: g.updated_at, content };
}

// 원격 → 로컬 최신화. force=false면 updated_at이 마지막 동기화와 같으면 건너뜀.
async function syncPull(force) {
  const cfg = loadSyncConfig();
  if (!cfg.gistId) return { ok: false, error: 'Gist ID가 설정되지 않았습니다' };
  sendSyncStatus({ type: 'checking' });
  try {
    const { updatedAt, content } = await gistFetchData(cfg.gistId, cfg.token);
    if (!force && cfg.lastSyncedAt && updatedAt === cfg.lastSyncedAt) {
      sendSyncStatus({ type: 'idle', lastSyncedAt: cfg.lastSyncedAt });
      return { ok: true, updated: false };
    }
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('원격 데이터 형식 오류'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('원격 데이터가 비어있습니다');
    saveData(parsed);
    cfg.lastSyncedAt = updatedAt;
    saveSyncConfig(cfg);
    broadcastDataChanged();
    sendSyncStatus({ type: 'updated', lastSyncedAt: updatedAt });
    return { ok: true, updated: true, updatedAt };
  } catch (err) {
    sendSyncStatus({ type: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// 로컬 → 원격 업로드. gistId 없으면 새 secret gist 생성.
async function syncUpload() {
  const cfg = loadSyncConfig();
  if (!cfg.token) return { ok: false, error: '업로드하려면 GitHub 토큰이 필요합니다' };
  sendSyncStatus({ type: 'uploading' });
  try {
    const content = fs.readFileSync(getDataPath(), 'utf-8');
    let gistId = cfg.gistId, updatedAt;
    if (gistId) {
      const g = await ghRequest('PATCH', `https://api.github.com/gists/${gistId}`, {
        token: cfg.token, body: { files: { [GIST_FILE]: { content } } },
      });
      updatedAt = g.updated_at;
    } else {
      const g = await ghRequest('POST', 'https://api.github.com/gists', {
        token: cfg.token,
        body: { description: '환경 모니터링 공유 일정 데이터', public: false, files: { [GIST_FILE]: { content } } },
      });
      gistId = g.id; updatedAt = g.updated_at;
    }
    cfg.gistId = gistId; cfg.lastSyncedAt = updatedAt;
    saveSyncConfig(cfg);
    sendSyncStatus({ type: 'uploaded', lastSyncedAt: updatedAt });
    return { ok: true, gistId, updatedAt };
  } catch (err) {
    sendSyncStatus({ type: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

let syncTimer = null;
function restartSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = loadSyncConfig();
  if (cfg.autoSync && cfg.gistId) {
    const ms = Math.max(1, cfg.intervalMin || 5) * 60 * 1000;
    syncTimer = setInterval(() => { syncPull(false); }, ms);
  }
}

// ─── 윈도우 생성 ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWin = new BrowserWindow({
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
    mainWin.loadURL('http://localhost:5173');
  } else {
    mainWin.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWin.removeMenu();

  mainWin.webContents.on('did-finish-load', () => {
    setupAsarUpdater(mainWin);
    // 실행 시 원격 최신화 1회 + 주기 동기화 시작
    if (!isDev) { syncPull(false); restartSyncTimer(); }
  });

  mainWin.on('closed', () => {
    if (orderManagerWin && !orderManagerWin.isDestroyed()) orderManagerWin.close();
    mainWin = null;
  });
}

// ─── 앱 시작 ────────────────────────────────────────────────────────────────────

const applyUpdateArg = !isDev && process.argv.find(a => a.startsWith('--apply-update='));

if (applyUpdateArg) {
  // Update-apply mode: copy asar, then relaunch normally (no window shown)
  app.on('ready', async () => {
    const updateSrc = applyUpdateArg.slice('--apply-update='.length);
    const asarDest = path.join(process.resourcesPath, 'app.asar');
    let applied = false;

    for (let i = 0; i < 20 && !applied; i++) {
      try {
        fs.copyFileSync(updateSrc, asarDest);
        applied = true;
      } catch {
        // app.asar may still be locked by the previous instance; wait and retry
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    try { fs.unlinkSync(updateSrc); } catch {}

    // Relaunch without the --apply-update arg
    const cleanArgs = process.argv.slice(1).filter(a => !a.startsWith('--apply-update='));
    app.relaunch({ args: cleanArgs });
    app.exit(0);
  });

} else {
  // Normal startup
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
}

// ─── IPC 핸들러 ────────────────────────────────────────────────────────────────

function registerHandlers() {

  // ── 업데이트 ──
  ipcMain.handle('update:check', checkForUpdate);
  ipcMain.handle('update:download', downloadUpdate);
  ipcMain.handle('update:install', applyUpdateAndRestart);

  // ── 공유 동기화 (Gist) ──
  ipcMain.handle('sync:getConfig', () => {
    const c = loadSyncConfig();
    return { gistId: c.gistId || '', hasToken: !!c.token, autoSync: c.autoSync !== false, intervalMin: c.intervalMin || 5, lastSyncedAt: c.lastSyncedAt || '' };
  });
  ipcMain.handle('sync:setConfig', (_e, patch = {}) => {
    const c = loadSyncConfig();
    if (patch.gistId !== undefined) c.gistId = String(patch.gistId).trim();
    if (patch.clearToken) c.token = '';
    else if (patch.token) c.token = String(patch.token).trim(); // 빈 값이면 기존 토큰 유지
    if (patch.autoSync !== undefined) c.autoSync = !!patch.autoSync;
    if (patch.intervalMin !== undefined) c.intervalMin = Math.max(1, parseInt(patch.intervalMin) || 5);
    saveSyncConfig(c);
    restartSyncTimer();
    return { ok: true };
  });
  ipcMain.handle('sync:upload', () => syncUpload());
  ipcMain.handle('sync:pull', () => syncPull(true));

  // ── 순서/그룹 관리 별도 창 (항상 위) ──
  const boundsFile = () => path.join(app.getPath('userData'), 'order-manager-bounds.json');
  function loadOrderBounds() {
    try {
      const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf-8'));
      if (b && typeof b.width === 'number' && typeof b.height === 'number') return b;
    } catch { /* ignore */ }
    return null;
  }
  function saveOrderBounds() {
    if (!orderManagerWin || orderManagerWin.isDestroyed()) return;
    try { fs.writeFileSync(boundsFile(), JSON.stringify(orderManagerWin.getBounds())); } catch { /* ignore */ }
  }

  ipcMain.handle('orderManager:open', () => {
    if (orderManagerWin && !orderManagerWin.isDestroyed()) {
      orderManagerWin.show();
      orderManagerWin.focus();
      return;
    }
    const saved = loadOrderBounds();
    orderManagerWin = new BrowserWindow({
      width: saved?.width ?? 1000,
      height: saved?.height ?? 660,
      ...(saved && typeof saved.x === 'number' ? { x: saved.x, y: saved.y } : {}),
      minWidth: 760,
      minHeight: 460,
      // 모든 창이 아니라 메인 창보다만 위로 유지 (자식 창)
      ...(mainWin && !mainWin.isDestroyed() ? { parent: mainWin } : {}),
      frame: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    orderManagerWin.removeMenu();
    if (isDev) {
      orderManagerWin.loadURL('http://localhost:5173/#order-manager');
    } else {
      orderManagerWin.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'order-manager' });
    }
    orderManagerWin.on('resize', saveOrderBounds);
    orderManagerWin.on('move', saveOrderBounds);
    orderManagerWin.on('close', saveOrderBounds);
    orderManagerWin.on('closed', () => { orderManagerWin = null; });
  });

  ipcMain.on('orderManager:close', () => {
    if (orderManagerWin && !orderManagerWin.isDestroyed()) orderManagerWin.close();
  });

  // 데이터 변경 브로드캐스트 — 모든 창에 새로고침 신호
  ipcMain.on('app:dataChanged', () => {
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('app:dataChanged');
    });
  });

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
    // Remove zone from any groups it belongs to
    data.groups = (data.groups || []).map(g => ({
      ...g,
      zoneIds: g.zoneIds.filter(zid => zid !== id),
    }));
    saveData(data);
  });

  // ── 그룹 ──
  ipcMain.handle('groups:getAll', () => {
    return loadData().groups;
  });

  ipcMain.handle('groups:upsert', (_e, group) => {
    const data = loadData();
    if (group.id) {
      const idx = data.groups.findIndex(g => g.id === group.id);
      if (idx >= 0) data.groups[idx] = group;
      else data.groups.push(group);
    } else {
      group.id = newId();
      data.groups.push(group);
    }
    saveData(data);
    return group;
  });

  ipcMain.handle('groups:delete', (_e, id) => {
    const data = loadData();
    data.groups = data.groups.filter(g => g.id !== id);
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

  // ── 측정주기 설정 ──
  ipcMain.handle('scheduleConfig:get', () => {
    return loadData().scheduleConfig || null;
  });

  ipcMain.handle('scheduleConfig:set', (_e, config) => {
    const data = loadData();
    data.scheduleConfig = config;
    saveData(data);
    return config;
  });

  // ── 공휴일 ──
  ipcMain.handle('holidays:getAll', () => {
    return loadData().holidays;
  });

  ipcMain.handle('holidays:upsert', (_e, holiday) => {
    const data = loadData();
    const idx = data.holidays.findIndex(h => h.date === holiday.date);
    if (idx >= 0) data.holidays[idx] = holiday;
    else data.holidays.push(holiday);
    saveData(data);
    return holiday;
  });

  ipcMain.handle('holidays:delete', (_e, date) => {
    const data = loadData();
    data.holidays = data.holidays.filter(h => h.date !== date);
    saveData(data);
  });

  // ── 측정 완료 ──
  ipcMain.handle('completions:getAll', () => loadData().completions);
  ipcMain.handle('completions:set', (_e, zoneId, num) => {
    const data = loadData();
    const key = `${zoneId}_${num}`;
    if (!data.completions.some(c => `${c.zoneId}_${c.num}` === key)) {
      data.completions.push({ zoneId, num, completedAt: new Date().toISOString() });
    }
    saveData(data);
  });
  ipcMain.handle('completions:delete', (_e, zoneId, num) => {
    const key = `${zoneId}_${num}`;
    const data = loadData();
    data.completions = data.completions.filter(c => `${c.zoneId}_${c.num}` !== key);
    saveData(data);
  });

  // ── 일정 비우기(차단 날짜) ──
  ipcMain.handle('blockedDates:getAll', () => loadData().blockedDates || []);
  ipcMain.handle('blockedDates:set', (_e, date, blocked) => {
    const data = loadData();
    if (!data.blockedDates) data.blockedDates = [];
    const has = data.blockedDates.includes(date);
    if (blocked && !has) data.blockedDates.push(date);
    else if (!blocked && has) data.blockedDates = data.blockedDates.filter(d => d !== date);
    saveData(data);
    return data.blockedDates;
  });

  // ── 임시 일정 ──
  ipcMain.handle('tempSchedules:getAll', () => loadData().tempSchedules);
  ipcMain.handle('tempSchedules:add', (_e, entry) => {
    const data = loadData();
    entry.id = newId();
    entry.createdAt = new Date().toISOString();
    data.tempSchedules.push(entry);
    saveData(data);
    return entry;
  });
  ipcMain.handle('tempSchedules:delete', (_e, id) => {
    const data = loadData();
    data.tempSchedules = data.tempSchedules.filter(t => t.id !== id);
    saveData(data);
  });
}
