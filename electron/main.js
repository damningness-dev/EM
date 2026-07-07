const { app, BrowserWindow, ipcMain, Notification, screen, Tray, Menu, nativeImage, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const isDev = !app.isPackaged;

// Windows 토스트 알림을 위해 AppUserModelID를 최대한 일찍(앱 준비 전) 지정한다.
// 설치본의 바로가기 AUMID(= build.appId)와 일치해야 알림이 표시된다.
try { app.setAppUserModelId('com.em.monitoring'); } catch { /* ignore */ }

// ─── ASAR 업데이터 ─────────────────────────────────────────────────────────────

const META_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-meta.json';
const ASAR_URL = 'https://github.com/damningness-dev/EM/releases/latest/download/app-patch.asar';

let mainWin = null;
let orderManagerWin = null;
let tray = null;
app.isQuitting = false;

// 단일 인스턴스 보장 — 두 번 실행 시 기존 창을 띄운다 (트레이 상주와 함께 필요).
// 단, 업데이트 적용 재실행(--apply-update) 중에는 락 경쟁을 피하기 위해 건너뛴다.
const _applyingUpdate = !isDev && process.argv.some(a => a.startsWith('--apply-update='));
if (!_applyingUpdate) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
    });
  }
}

function createTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('환경 모니터링 관리 시스템');
    const menu = Menu.buildFromTemplate([
      { label: '열기', click: () => { if (mainWin) { mainWin.show(); mainWin.focus(); } } },
      { type: 'separator' },
      { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => { if (mainWin) { mainWin.isVisible() ? mainWin.focus() : mainWin.show(); } });
    tray.on('double-click', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  } catch { /* ignore */ }
}

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

// 주기적 확인 상태 — 다운로드 완료/진행 중 상태를 이후 확인이 덮어쓰지 않게 한다
let downloadingUpdate = false;
let downloadedVersion = null;
let balloonVersion = null;

async function checkForUpdate() {
  if (downloadingUpdate) return; // 다운로드 중엔 상태를 건드리지 않음
  sendStatus({ type: 'checking' });
  try {
    const meta = await fetchJSON(META_URL);
    if (meta.version === app.getVersion()) {
      sendStatus({ type: 'latest' });
    } else if (downloadedVersion === meta.version) {
      // 이미 받아둔 버전 — '지금 재시작' 안내 유지
      sendStatus({ type: 'downloaded', version: meta.version });
    } else {
      sendStatus({ type: 'available', version: meta.version });
      // 트레이 풍선 알림 (버전당 1회) — 창이 숨겨져 있어도 새 버전을 알 수 있게
      if (balloonVersion !== meta.version) {
        balloonVersion = meta.version;
        try {
          if (tray && process.platform === 'win32') {
            tray.displayBalloon({ title: '환경 모니터링 업데이트', content: `새 버전 v${meta.version}이 있습니다. 앱을 열어 다운로드하세요.` });
          }
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    // 404 = 아직 게시된 릴리즈에 app-meta.json이 없음 (정상, 조용히 무시)
    if (err.message.startsWith('HTTP 404')) return;
    sendStatus({ type: 'error', message: `업데이트 확인 실패: ${err.message}` });
  }
}

async function downloadUpdate() {
  const dest = getUpdatePath();
  downloadingUpdate = true;
  try {
    const meta = await fetchJSON(META_URL);
    const sha256 = await downloadAsar(ASAR_URL, dest);

    if (meta.sha256 && sha256 !== meta.sha256) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error('파일 검증 실패 (체크섬 불일치)');
    }

    downloadedVersion = meta.version;
    sendStatus({ type: 'downloaded', version: meta.version });
  } catch (err) {
    try { fs.unlinkSync(dest); } catch {}
    sendStatus({ type: 'error', message: err.message });
  } finally {
    downloadingUpdate = false;
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

let updateCheckTimer = null;
function setupAsarUpdater(win) {
  if (isDev) return;
  mainWin = win;
  setTimeout(checkForUpdate, 5000);
  // 주기적 자동 확인 — 새 패치가 업로드되면 실행 중에도 자동으로 감지 (10분 간격)
  if (!updateCheckTimer) {
    updateCheckTimer = setInterval(checkForUpdate, 10 * 60 * 1000);
  }
  // 트레이에서 창을 다시 열 때도 즉시 확인
  win.removeAllListeners('show');
  win.on('show', () => { setTimeout(checkForUpdate, 1000); });
}

// ─── 로컬 데이터 저장 ──────────────────────────────────────────────────────────

function getDataPath() {
  return path.join(app.getPath('userData'), 'em-data.json');
}

function loadData() {
  const p = getDataPath();
  if (!fs.existsSync(p)) {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [], todos: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data.groups) data.groups = [];
    if (!data.holidays) data.holidays = [];
    if (!data.completions) data.completions = [];
    if (!data.tempSchedules) data.tempSchedules = [];
    if (!data.blockedDates) data.blockedDates = [];
    if (!data.todos) data.todos = [];
    if (!data.users) data.users = [];
    return data;
  } catch {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [], todos: [], users: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(getDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function newId() {
  return crypto.randomUUID();
}

// ─── 앱 환경설정 / 부팅 시 자동 시작 ──────────────────────────────────────────

function prefsPath() { return path.join(app.getPath('userData'), 'app-prefs.json'); }
function loadPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf-8')) || {}; } catch { return {}; } }
function savePrefs(p) { try { fs.writeFileSync(prefsPath(), JSON.stringify(p, null, 2)); } catch { /* ignore */ } }

// 부팅 시 자동 시작 등록/해제. 로그인 시엔 '--hidden'으로 실행 → 창 없이 트레이 상주.
const AUTOSTART_ARGS = ['--hidden'];
function applyAutoStart(enabled) {
  try {
    if (isDev) return; // 개발 모드에선 등록하지 않음
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: AUTOSTART_ARGS });
  } catch { /* ignore */ }
}
// 현재 상태 조회 — 설정값(prefs)을 기준으로 하고, 없으면 OS에 질의.
// 주의: args로 등록한 로그인 항목은 같은 args로 질의해야 정확히 나온다(Windows).
function getAutoStartEnabled() {
  const p = loadPrefs();
  if (typeof p.autoStartEnabled === 'boolean') return p.autoStartEnabled;
  try { return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin; } catch { return false; }
}
// 최초 실행 시 기본으로 자동 시작을 켠다(이후 사용자가 끄면 그 설정을 존중).
function initAutoStart() {
  const p = loadPrefs();
  if (!p.autoStartInitialized) {
    applyAutoStart(true);
    p.autoStartInitialized = true;
    p.autoStartEnabled = true;
    savePrefs(p);
  } else {
    // 업데이트로 실행 경로가 바뀌었을 수 있으니 저장된 설정을 다시 적용
    applyAutoStart(p.autoStartEnabled !== false);
  }
}

// ─── 공유 동기화 (GitHub Gist) ────────────────────────────────────────────────
// 일정 데이터(em-data.json)를 Gist에 업로드해 공유하고, 다른 PC는 주기적으로
// 내려받아 최신화한다. 업로드는 토큰이 있는 관리자만, 읽기는 토큰 없이 가능.

const GIST_FILE = 'em-data.json';

function syncConfigPath() {
  return path.join(app.getPath('userData'), 'sync-config.json');
}
function loadSyncConfig() {
  const def = { gistId: '', token: '', autoSync: true, intervalMin: 5, lastSyncedAt: '', role: 'member', requesterName: '' };
  try {
    const c = JSON.parse(fs.readFileSync(syncConfigPath(), 'utf-8'));
    return { ...def, ...c };
  } catch {
    return def;
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

// ─── 편집 요청 (Gist 댓글 기반) ───────────────────────────────────────────────
// 멤버(관리자 아님)가 일정 이동을 '요청'하면 공유 Gist에 댓글로 남긴다.
// 관리자는 댓글을 읽어 달력에 표시하고, 적용/삭제할 수 있다.
const REQ_MARKER = 'EM-EDIT-REQ:';

async function submitEditRequest(req) {
  const cfg = loadSyncConfig();
  if (!cfg.gistId) return { ok: false, error: 'Gist가 설정되지 않았습니다' };
  if (!cfg.token) return { ok: false, error: '편집 요청하려면 GitHub 토큰이 필요합니다' };
  const payload = { ...req, requester: req.requester || cfg.requesterName || '익명', ts: new Date().toISOString() };
  try {
    const c = await ghRequest('POST', `https://api.github.com/gists/${cfg.gistId}/comments`, {
      token: cfg.token, body: { body: REQ_MARKER + JSON.stringify(payload) },
    });
    return { ok: true, id: c.id };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function getEditRequests() {
  const cfg = loadSyncConfig();
  if (!cfg.gistId) return [];
  try {
    const comments = await ghRequest('GET', `https://api.github.com/gists/${cfg.gistId}/comments?per_page=100`, { token: cfg.token || undefined });
    const out = [];
    (comments || []).forEach(c => {
      const b = (c.body || '').trim();
      if (!b.startsWith(REQ_MARKER)) return;
      try { out.push({ commentId: c.id, ...JSON.parse(b.slice(REQ_MARKER.length)) }); } catch { /* ignore */ }
    });
    return out;
  } catch { return []; }
}

async function resolveEditRequest(commentId) {
  const cfg = loadSyncConfig();
  if (!cfg.gistId || !cfg.token) return { ok: false, error: '권한이 없습니다 (토큰 필요)' };
  try {
    await ghRequest('DELETE', `https://api.github.com/gists/${cfg.gistId}/comments/${commentId}`, { token: cfg.token });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ─── 할일(반복 일정) 알람 ──────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

// todo가 특정 날짜에 발생하는지 (반복주기 반영)
function todoOccursOn(todo, dateStr) {
  if (!todo.date || dateStr < todo.date) return false;
  const repeat = todo.repeat || 'none';
  if (repeat === 'none') return dateStr === todo.date;
  const base = new Date(todo.date + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const interval = Math.max(1, todo.interval || 1);
  const dayDiff = Math.round((d - base) / 86400000);
  if (repeat === 'daily') return dayDiff >= 0 && dayDiff % interval === 0;
  if (repeat === 'weekly') return dayDiff >= 0 && dayDiff % (7 * interval) === 0;
  if (repeat === 'monthly') {
    if (d.getDate() !== base.getDate()) return false;
    const m = (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
    return m >= 0 && m % interval === 0;
  }
  if (repeat === 'yearly') {
    if (d.getDate() !== base.getDate() || d.getMonth() !== base.getMonth()) return false;
    const y = d.getFullYear() - base.getFullYear();
    return y >= 0 && y % interval === 0;
  }
  return false;
}

// 데스크톱 알람 팝업 창 — 항상 위에 뜨는 별도 창(윈도우 알림 설정과 무관하게 확실히 표시)
let alarmWindows = [];
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function showAlarmWindow(todo) {
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const W = 360, H = 150;
    const offset = alarmWindows.length * (H + 10);
    const win = new BrowserWindow({
      width: W, height: H,
      x: wa.width - W - 16,
      y: Math.max(16, wa.height - H - 16 - offset),
      frame: false, resizable: false, movable: true, minimizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%}
      body{font-family:'Malgun Gothic','Segoe UI',sans-serif;background:#fff;border:2px solid #fb923c;border-radius:12px;box-sizing:border-box;display:flex;flex-direction:column;padding:14px;overflow:hidden}
      .h{display:flex;align-items:center;gap:6px;color:#ea580c;font-size:12px;font-weight:700;margin-bottom:6px}
      .t{font-size:15px;font-weight:700;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .n{font-size:12px;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      button{margin-top:auto;padding:8px;background:#f97316;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
      button:hover{background:#ea580c}
    </style></head><body>
      <div class="h">⏰ 할일 알람 ${todo.time ? '· ' + esc(todo.time) : ''}</div>
      <div class="t">${esc(todo.title)}</div>
      ${todo.note ? `<div class="n">${esc(todo.note)}</div>` : ''}
      <button onclick="window.close()">확인</button>
    </body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.once('ready-to-show', () => { win.show(); win.moveTop(); });
    win.on('closed', () => { alarmWindows = alarmWindows.filter(x => x !== win); });
    alarmWindows.push(win);
    // 2분 후 자동 닫힘
    setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 120000);
  } catch { /* ignore */ }
}

const firedAlarms = new Set(); // `${id}_${yyyy-MM-dd}` — 하루 1회 발사 보장
let alarmTimer = null;
let alarmBlockerId = null;
function checkAlarms() {
  let data;
  try { data = loadData(); } catch { return; }
  const todos = data.todos || [];
  if (!todos.length) return;
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const nowHM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  todos.forEach(t => {
    if (!t.alarmEnabled || !t.time) return;
    if (!todoOccursOn(t, todayStr)) return;
    if ((t.completedDates || []).includes(todayStr)) return;
    if (nowHM < t.time) return;
    const key = `${t.id}_${todayStr}`;
    if (firedAlarms.has(key)) return;
    firedAlarms.add(key);
    // 1) 데스크톱 팝업 창 (항상 위) — 윈도우 알림 설정과 무관하게 확실히 표시
    showAlarmWindow(t);
    // 2) 작업표시줄 깜빡임
    try { if (mainWin && !mainWin.isDestroyed()) mainWin.flashFrame(true); } catch { /* ignore */ }
    // 3) 윈도우 네이티브 토스트 알림 (환경에 따라 표시)
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: '⏰ 할일 알림', body: (t.title || '할일') + (t.note ? `\n${t.note}` : ''), silent: false });
        n.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
        n.show();
      }
    } catch { /* ignore */ }
  });
}
function startAlarmScheduler() {
  // 윈도우가 백그라운드 앱을 절전 스로틀링하면 타이머가 멈춰 알람이 밀린다.
  // prevent-app-suspension으로 스로틀링을 막아 실행 중에도 제때 울리게 한다.
  try {
    if (alarmBlockerId === null || !powerSaveBlocker.isStarted(alarmBlockerId)) {
      alarmBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch { /* ignore */ }

  // 분 경계(HH:MM:00)에 맞춰 체크 — 알람이 설정 시각에서 1초 이내에 울리게 한다.
  // 매 틱마다 실제 시계 기준으로 다음 분까지 남은 시간을 다시 계산해 드리프트를 보정.
  if (alarmTimer) { clearTimeout(alarmTimer); alarmTimer = null; }
  const tick = () => {
    try { checkAlarms(); } catch { /* ignore */ }
    const msToNextMinute = 60000 - (Date.now() % 60000) + 200; // 다음 분 + 0.2초 여유
    alarmTimer = setTimeout(tick, Math.min(Math.max(msToNextMinute, 1000), 60200));
  };
  tick();

  // 절전 복귀/화면 잠금해제 시 즉시 확인 (잠자는 동안 지난 알람 바로 표시)
  try {
    powerMonitor.removeAllListeners('resume');
    powerMonitor.removeAllListeners('unlock-screen');
    powerMonitor.on('resume', () => { try { checkAlarms(); } catch { /* ignore */ } });
    powerMonitor.on('unlock-screen', () => { try { checkAlarms(); } catch { /* ignore */ } });
  } catch { /* ignore */ }
}

// ─── 윈도우 생성 ────────────────────────────────────────────────────────────────

function createWindow() {
  // 부팅 시 자동 실행(로그인 항목)은 '--hidden'으로 실행 → 창 없이 트레이 상주.
  const startHidden = process.argv.includes('--hidden');
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
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

  // 창 닫기 = 트레이로 숨김(백그라운드 유지) → 알람 스케줄러가 계속 동작.
  // 완전 종료는 트레이 메뉴의 '종료'로.
  mainWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
      if (orderManagerWin && !orderManagerWin.isDestroyed()) orderManagerWin.hide();
    }
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
    createTray();
    initAutoStart();
    startAlarmScheduler();
  });

  app.on('before-quit', () => { app.isQuitting = true; });

  // 트레이 상주: 창을 닫아도 종료하지 않는다 (알람이 계속 동작).
  // 완전 종료는 트레이 메뉴 '종료'로만.
  app.on('window-all-closed', () => { /* keep running in tray */ });

  app.on('activate', () => {
    if (mainWin) mainWin.show();
    else if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
    return { gistId: c.gistId || '', hasToken: !!c.token, autoSync: c.autoSync !== false, intervalMin: c.intervalMin || 5, lastSyncedAt: c.lastSyncedAt || '', role: c.role || 'member', requesterName: c.requesterName || '' };
  });
  ipcMain.handle('sync:setConfig', (_e, patch = {}) => {
    const c = loadSyncConfig();
    if (patch.gistId !== undefined) c.gistId = String(patch.gistId).trim();
    if (patch.clearToken) c.token = '';
    else if (patch.token) c.token = String(patch.token).trim(); // 빈 값이면 기존 토큰 유지
    if (patch.autoSync !== undefined) c.autoSync = !!patch.autoSync;
    if (patch.intervalMin !== undefined) c.intervalMin = Math.max(1, parseInt(patch.intervalMin) || 5);
    if (patch.role !== undefined) c.role = patch.role === 'admin' ? 'admin' : 'member';
    if (patch.requesterName !== undefined) c.requesterName = String(patch.requesterName).trim();
    saveSyncConfig(c);
    restartSyncTimer();
    return { ok: true };
  });
  ipcMain.handle('sync:upload', () => syncUpload());
  ipcMain.handle('sync:pull', () => syncPull(true));

  // ── 부팅 시 자동 시작 ──
  ipcMain.handle('app:getAutoStart', () => getAutoStartEnabled());
  ipcMain.handle('app:setAutoStart', (_e, enabled) => {
    applyAutoStart(enabled);
    const p = loadPrefs();
    p.autoStartInitialized = true;
    p.autoStartEnabled = !!enabled;
    savePrefs(p);
    return { ok: true, enabled: !!enabled };
  });

  // ── 사용자 명부(권한) ──
  ipcMain.handle('users:getAll', () => loadData().users || []);
  ipcMain.handle('users:upsert', (_e, user) => {
    const data = loadData();
    if (!data.users) data.users = [];
    const empNo = String(user.empNo || '').trim();
    if (!empNo) return { ok: false, error: '사번이 필요합니다' };
    const i = data.users.findIndex(u => String(u.empNo) === empNo);
    const rec = { empNo, name: String(user.name || '').trim(), role: user.role === 'admin' ? 'admin' : 'member' };
    if (i >= 0) data.users[i] = rec; else data.users.push(rec);
    saveData(data);
    return { ok: true, user: rec };
  });
  ipcMain.handle('users:delete', (_e, empNo) => {
    const data = loadData();
    data.users = (data.users || []).filter(u => String(u.empNo) !== String(empNo));
    saveData(data);
    return { ok: true };
  });

  // ── 편집 요청 ──
  ipcMain.handle('sync:submitEditRequest', (_e, req) => submitEditRequest(req));
  ipcMain.handle('sync:getEditRequests', () => getEditRequests());
  ipcMain.handle('sync:resolveEditRequest', (_e, commentId) => resolveEditRequest(commentId));

  // ── 할일(반복 일정) ──
  ipcMain.handle('todos:getAll', () => loadData().todos || []);
  ipcMain.handle('todos:upsert', (_e, todo) => {
    const data = loadData();
    if (!data.todos) data.todos = [];
    if (todo.id) {
      const i = data.todos.findIndex(t => t.id === todo.id);
      if (i >= 0) data.todos[i] = todo; else data.todos.push(todo);
      // 알람 시간을 수정했으면 오늘자 발사 기록을 지워 새 시간에 다시 울리게 한다
      firedAlarms.forEach(k => { if (k.startsWith(todo.id + '_')) firedAlarms.delete(k); });
    } else {
      todo.id = newId();
      if (!todo.completedDates) todo.completedDates = [];
      data.todos.push(todo);
    }
    saveData(data);
    // 방금 저장한 알람이 이미 지난 시각이면 바로 표시
    setTimeout(() => { try { checkAlarms(); } catch { /* ignore */ } }, 500);
    return todo;
  });
  ipcMain.handle('todos:delete', (_e, id) => {
    const data = loadData();
    data.todos = (data.todos || []).filter(t => t.id !== id);
    saveData(data);
    return true;
  });
  ipcMain.handle('todos:toggleDone', (_e, id, dateStr) => {
    const data = loadData();
    const t = (data.todos || []).find(x => x.id === id);
    if (t) {
      if (!t.completedDates) t.completedDates = [];
      const i = t.completedDates.indexOf(dateStr);
      if (i >= 0) t.completedDates.splice(i, 1); else t.completedDates.push(dateStr);
      saveData(data);
    }
    return t;
  });

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
