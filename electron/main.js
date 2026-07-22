const { app, BrowserWindow, ipcMain, Notification, screen, Tray, Menu, nativeImage, powerSaveBlocker, powerMonitor, shell, dialog } = require('electron');
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

// _bustCache: 회사/공유망의 캐싱 프록시가 릴리즈 다운로드 URL을 자체적으로
// 캐싱해 두었다가 우리가 조건부 요청을 보내지도 않았는데 304(Not Modified)로
// 응답하는 경우가 있다(예: "HTTP 304" 업데이트 확인 오류). 이 요청은 매번 최신
// 내용을 받아야 하므로 캐시를 쓰지 말라고 명시하고, 그래도 304가 오면 URL에
// 캐시 무효화용 쿼리를 붙여 한 번 더 시도해 프록시 캐시를 우회한다.
function httpGet(url, _bustCache) {
  return new Promise((resolve, reject) => {
    const target = _bustCache
      ? url + (url.includes('?') ? '&' : '?') + '_ts=' + Date.now()
      : url;
    const mod = target.startsWith('https:') ? https : http;
    mod.get(target, { headers: {
      'User-Agent': 'em-updater/1.0',
      'Cache-Control': 'no-cache, no-store',
      'Pragma': 'no-cache',
    } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve(httpGet(res.headers.location));
      } else if (res.statusCode === 304 && !_bustCache) {
        res.resume();
        resolve(httpGet(url, true));
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
    // 청크를 문자열로 바로 이어붙이면(body += chunk) 멀티바이트 문자(한글 등)가
    // 청크 경계에서 잘려 깨질 수 있다. Buffer로 모았다가 한 번에 디코딩한다.
    const chunks = [];
    res.on('data', chunk => { chunks.push(chunk); });
    res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch (e) { reject(e); } });
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

    res.on('end', () => {
      // 서버가 보낸 크기와 실제 받은 크기가 다르면(연결 중간 끊김 등) 잘린 파일이
      // 조용히 "정상 다운로드"로 취급되어 체크섬 오류로만 나타나던 문제를 방지 —
      // 여기서 먼저 걸러서 더 명확한 원인(다운로드 중단)으로 표시한다.
      if (total > 0 && downloaded !== total) {
        out.end(() => { try { fs.unlinkSync(dest); } catch {} reject(new Error(`다운로드가 중간에 끊겼습니다 (${downloaded}/${total} bytes)`)); });
        return;
      }
      out.end(() => resolve(hash.digest('hex')));
    });

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

// 체크섬 불일치/다운로드 중단은 대부분 네트워크 순간 끊김이나 배포 직후 CDN
// 전파 지연(에지 노드에 새 파일이 아직 안 퍼진 상태) 때문에 생기는 일시적
// 문제라, 사용자가 매번 직접 "다시 확인"을 누르지 않도록 여기서 자동 재시도한다.
const DOWNLOAD_RETRIES = 3;

async function downloadUpdate() {
  const dest = getUpdatePath();
  downloadingUpdate = true;
  let lastErr = null;
  try {
    const meta = await fetchJSON(META_URL);
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        const sha256 = await downloadAsar(ASAR_URL, dest);
        if (meta.sha256 && sha256 !== meta.sha256) {
          throw new Error(`파일 검증 실패 (체크섬 불일치)${attempt < DOWNLOAD_RETRIES ? ` — 재시도 중 (${attempt}/${DOWNLOAD_RETRIES})` : ''}`);
        }
        downloadedVersion = meta.version;
        sendStatus({ type: 'downloaded', version: meta.version });
        return;
      } catch (err) {
        lastErr = err;
        try { fs.unlinkSync(dest); } catch {}
        if (attempt < DOWNLOAD_RETRIES) {
          sendStatus({ type: 'checking' }); // 재시도 중임을 알림(스피너 유지)
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }
    throw lastErr;
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
  // 주기적 자동 확인 — 새 패치가 업로드되면 실행 중에도 자동으로 감지 (3분 간격)
  if (!updateCheckTimer) {
    updateCheckTimer = setInterval(checkForUpdate, 3 * 60 * 1000);
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

// 할일(오늘의 할일)은 설치본 간 공유되는 em-data.json이 아니라 각 PC의
// 로컬 파일에서 독립적으로 관리한다 (공유 동기화로 다른 PC 목록이 덮어쓰지 않도록).
function todosPath() {
  return path.join(app.getPath('userData'), 'todos-local.json');
}
function loadTodos() {
  try {
    if (!fs.existsSync(todosPath())) return [];
    return JSON.parse(fs.readFileSync(todosPath(), 'utf-8')) || [];
  } catch { return []; }
}
function saveTodos(todos) {
  fs.writeFileSync(todosPath(), JSON.stringify(todos, null, 2), 'utf-8');
}
// 구버전 호환: em-data.json에 저장되어 있던 할일을 로컬 파일로 최초 1회 이관.
// saveData()가 todos 필드를 지워버리기 전에, 앱 시작 직후(IPC 등록 전) 반드시 먼저 실행해야 한다.
function migrateLegacyTodosOnce() {
  if (fs.existsSync(todosPath())) return;
  let legacy = [];
  try {
    const p = getDataPath();
    if (fs.existsSync(p)) legacy = JSON.parse(fs.readFileSync(p, 'utf-8')).todos || [];
  } catch { /* ignore */ }
  saveTodos(legacy);
}

function saveData(data) {
  const clean = { ...data };
  delete clean.todos; // 할일은 todos-local.json에서 별도 관리
  delete clean.users; // 사용자 명부(구 기능) — 관리자 비밀번호로 대체됨
  fs.writeFileSync(getDataPath(), JSON.stringify(clean, null, 2), 'utf-8');
}

function newId() {
  return crypto.randomUUID();
}

// ─── 관리자 잠금 (일정 편집 권한) ──────────────────────────────────────────────
// 사용자 명부 대신 단일 관리자 비밀번호로 일정 편집 권한을 게이트한다.
// 비밀번호 해시는 공유 데이터(em-data.json)에 저장되어 여러 PC가 같은 비밀번호를 쓴다.
// 잠금 해제 상태(adminUnlocked)는 프로세스 메모리에만 있어 앱을 새로 시작하면 항상 잠김.
let adminUnlocked = false;
function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw || '')).digest('hex');
}
function broadcastAdminUnlocked() {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('admin:unlockChanged', adminUnlocked); });
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
  const def = { gistId: '', token: '', autoSync: true, intervalMin: 5, lastSyncedAt: '', etag: '', role: 'member', requesterName: '' };
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
function ghRequest(method, apiUrl, { token, body, extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'User-Agent': 'em-sync/1.0', 'Accept': 'application/vnd.github+json', ...extraHeaders };
    if (token) headers['Authorization'] = 'token ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      // 청크를 문자열로 바로 이어붙이면(out += chunk) 한글 등 멀티바이트 문자가
      // 청크 경계에서 잘려 깨질 수 있다(예: 구역 이름 일부만 깨짐). Buffer로 모았다가
      // 한 번에 UTF-8로 디코딩해야 안전하다.
      const chunks = [];
      res.on('data', c => { chunks.push(c); });
      res.on('end', () => {
        const etag = res.headers.etag || '';
        // 304 Not Modified — If-None-Match 조건부 요청에 대한 응답이며 GitHub API
        // 사용량 한도(rate limit)에 포함되지 않는다. 본문이 없으므로 별도 처리.
        if (res.statusCode === 304) { resolve({ notModified: true, etag }); return; }
        const out = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ json: JSON.parse(out || '{}'), etag }); } catch (e) { reject(e); }
        } else {
          // GitHub는 오류 본문에 원인을 담아 준다(예: "Bad credentials",
          // "API rate limit exceeded", "Resource not accessible by personal access
          // token" 등) — 이 메시지를 그대로 보여줘야 사용자가 원인을 구분할 수 있다.
          let reason = '';
          try { reason = JSON.parse(out)?.message || ''; } catch { /* 본문이 JSON이 아니면 무시 */ }
          reject(new Error(`HTTP ${res.statusCode}${reason ? ': ' + reason : ''}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Gist에서 데이터 파일 내용 + updated_at 조회 (1MB 초과 truncated면 raw_url로 재조회)
// etag를 넘기면 If-None-Match 조건부 요청을 보낸다 — 원격에 변경이 없으면 GitHub가
// 본문 없이 304만 응답하고, 이 요청은 API 사용량 한도에 포함되지 않는다. 여러 PC가
// 토큰 없이(비인증) 주기적으로 자동 동기화할 때 시간당 60회 한도를 빨리 소진해
// "API rate limit exceeded" 오류가 나던 문제를 크게 줄여준다.
async function gistFetchData(gistId, token, etag) {
  const r = await ghRequest('GET', `https://api.github.com/gists/${gistId}`, {
    token: token || undefined,
    extraHeaders: etag ? { 'If-None-Match': etag } : undefined,
  });
  if (r.notModified) return { notModified: true, etag: r.etag };
  const g = r.json;
  const file = g.files && g.files[GIST_FILE];
  if (!file) throw new Error(`Gist에 ${GIST_FILE} 파일이 없습니다`);
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const res = await httpGet(file.raw_url);
    if (res.statusCode !== 200) { res.resume(); throw new Error(`raw HTTP ${res.statusCode}`); }
    content = await new Promise((resolve, reject) => {
      // Buffer로 모았다가 한 번에 디코딩 (청크 경계에서 멀티바이트 문자가 깨지는 것 방지)
      const chunks = [];
      res.on('data', c => { chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
  }
  return { updatedAt: g.updated_at, content, etag: r.etag };
}

// 원격 → 로컬 최신화. force=false면 updated_at이 마지막 동기화와 같으면 건너뜀.
async function syncPull(force) {
  const cfg = loadSyncConfig();
  if (!cfg.gistId) return { ok: false, error: 'Gist ID가 설정되지 않았습니다' };
  sendSyncStatus({ type: 'checking' });
  try {
    const r = await gistFetchData(cfg.gistId, cfg.token, cfg.etag);
    if (r.notModified) {
      if (r.etag && r.etag !== cfg.etag) { cfg.etag = r.etag; saveSyncConfig(cfg); }
      sendSyncStatus({ type: 'idle', lastSyncedAt: cfg.lastSyncedAt });
      return { ok: true, updated: false };
    }
    const { updatedAt, content, etag } = r;
    if (!force && cfg.lastSyncedAt && updatedAt === cfg.lastSyncedAt) {
      cfg.etag = etag; saveSyncConfig(cfg);
      sendSyncStatus({ type: 'idle', lastSyncedAt: cfg.lastSyncedAt });
      return { ok: true, updated: false };
    }
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('원격 데이터 형식 오류'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('원격 데이터가 비어있습니다');
    saveData(parsed);
    cfg.lastSyncedAt = updatedAt;
    cfg.etag = etag;
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
    let gistId = cfg.gistId, updatedAt, etag;
    if (gistId) {
      const r = await ghRequest('PATCH', `https://api.github.com/gists/${gistId}`, {
        token: cfg.token, body: { files: { [GIST_FILE]: { content } } },
      });
      updatedAt = r.json.updated_at; etag = r.etag;
    } else {
      const r = await ghRequest('POST', 'https://api.github.com/gists', {
        token: cfg.token,
        body: { description: '환경 모니터링 공유 일정 데이터', public: false, files: { [GIST_FILE]: { content } } },
      });
      gistId = r.json.id; updatedAt = r.json.updated_at; etag = r.etag;
    }
    cfg.gistId = gistId; cfg.lastSyncedAt = updatedAt; cfg.etag = etag || '';
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

// ─── 할일(반복 일정) 알람 ──────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function hm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function addDaysStr(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
function minusMinutes(hmStr, mins) {
  const [h, m] = (hmStr || '00:00').split(':').map(Number);
  let t = h * 60 + m - (mins || 0);
  if (t < 0) t = 0;
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}
// 해당 월의 n번째 요일(1~4, 5=마지막) 날짜(day) 반환
function nthWeekdayOfMonth(year, month0, nth, dow) {
  const firstDow = new Date(year, month0, 1).getDay();
  let day = 1 + ((dow - firstDow + 7) % 7);
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  if (nth === 5) { while (day + 7 <= daysInMonth) day += 7; }
  else { day += (nth - 1) * 7; if (day > daysInMonth) return null; }
  return day;
}

// todo가 특정 날짜에 발생하는지 (일정 반복 반영). 반복 없음 + 마감기한이면 마감까지 매일.
function todoOccursOn(todo, dateStr) {
  if (!todo.date || dateStr < todo.date) return false;
  const repeat = todo.repeat || 'none';
  if (repeat === 'none') {
    if (todo.due) return dateStr <= todo.due; // 마감까지 매일 표시
    return dateStr === todo.date;
  }
  if (todo.due && dateStr > todo.due) return false; // 마감 이후 중단
  const base = new Date(todo.date + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const interval = Math.max(1, todo.interval || 1);
  const dayDiff = Math.round((d - base) / 86400000);
  if (repeat === 'daily') return dayDiff >= 0 && dayDiff % interval === 0;
  if (repeat === 'weekly') return dayDiff >= 0 && dayDiff % (7 * interval) === 0;
  // 월/분기/반기/년
  const per = repeat === 'monthly' ? 1 : repeat === 'quarter' ? 3 : repeat === 'half' ? 6 : repeat === 'yearly' ? 12 : 0;
  if (per > 0) {
    const step = per * interval;
    const months = (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
    if (months < 0 || months % step !== 0) return false;
    if (repeat === 'monthly' && todo.monthlyMode === 'nthWeekday') {
      const day = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), todo.nth || 1, todo.dow || 0);
      return day != null && d.getDate() === day;
    }
    const dom = (repeat === 'monthly' && todo.monthlyMode === 'day' && todo.monthlyDay) ? todo.monthlyDay : base.getDate();
    return d.getDate() === dom;
  }
  return false;
}

// 알람 설정 정규화 (구형 alarmEnabled/time → 신형 alarm 객체)
function todoAlarm(todo) {
  if (todo.alarm && typeof todo.alarm === 'object') return todo.alarm;
  if (todo.alarmEnabled && todo.time) return { enabled: true, mode: 'atTime', time: todo.time, base: 'each' };
  return null;
}

// 지금(now) 이 todo의 알람을 울려야 하면 { key, occDay } 반환, 아니면 null.
function todoAlarmDueNow(todo, now) {
  const a = todoAlarm(todo);
  if (!a || !a.enabled || !a.time) return null;
  const todayStr = ymd(now);
  const nowHM = hm(now);
  const mode = a.mode || 'atTime';
  const base = a.base || 'each';

  // 이 알람이 겨냥하는 '기준일'(occDay) 후보를 구한다.
  let occDays = [];
  if (base === 'start') occDays = todo.date ? [todo.date] : [];
  else if (base === 'end') occDays = todo.due ? [todo.due] : [];
  else { // each: 오늘 기준으로 알람 대상 occurrence를 역산
    if (mode === 'dayBefore') { const occ = addDaysStr(todayStr, a.dayBefore || 0); if (todoOccursOn(todo, occ)) occDays = [occ]; }
    else if (todoOccursOn(todo, todayStr)) occDays = [todayStr];
  }
  for (const occDay of occDays) {
    // 알람이 실제로 울리는 날짜/시각
    let alarmDay = occDay;
    if (mode === 'dayBefore') alarmDay = addDaysStr(occDay, -(a.dayBefore || 0));
    if (alarmDay !== todayStr) continue;
    const fireHM = mode === 'minBefore' ? minusMinutes(a.time, a.minBefore || 0) : a.time;
    if (nowHM < fireHM) continue;
    if ((todo.completedDates || []).includes(occDay)) continue;
    const key = `${todo.id}_${occDay}_${mode}`;
    if (firedAlarms.has(key)) continue;
    return { key, occDay };
  }
  return null;
}

// 데스크톱 알람 팝업 창 — 항상 위에 뜨는 별도 창(윈도우 알림 설정과 무관하게 확실히 표시)
// 알람은 한 번에 하나씩. 확인(창 닫기) 전까지 유지되고, 그 사이 발생한 알람은
// 대기열에 쌓았다가 확인하면 다음 알람을 표시한다.
let alarmQueue = [];
let currentAlarmWin = null;
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function enqueueAlarm(todo) {
  alarmQueue.push(todo);
  showNextAlarm();
}

function showNextAlarm() {
  if (currentAlarmWin && !currentAlarmWin.isDestroyed()) return; // 앞 알람 확인 대기
  const todo = alarmQueue.shift();
  if (!todo) return;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const W = 360, H = 150;
    const win = new BrowserWindow({
      width: W, height: H,
      x: wa.width - W - 16,
      y: Math.max(16, wa.height - H - 16),
      frame: false, resizable: false, movable: true, minimizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true },
    });
    currentAlarmWin = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
    const remain = alarmQueue.length;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0}
      body{font-family:'Malgun Gothic','Segoe UI',sans-serif;background:#fff;border:2px solid #fb923c;border-radius:12px;box-sizing:border-box;display:flex;flex-direction:column;padding:14px;overflow:hidden}
      .h{display:flex;align-items:center;gap:6px;color:#ea580c;font-size:12px;font-weight:700;margin-bottom:6px}
      .q{margin-left:auto;font-size:11px;color:#9ca3af;font-weight:600}
      .t{font-size:15px;font-weight:700;color:#111827;white-space:pre-wrap;word-break:break-word;line-height:1.35}
      .n{font-size:12px;color:#6b7280;margin-top:4px;white-space:pre-wrap;word-break:break-word;line-height:1.35}
      button{margin-top:12px;padding:8px;background:#f97316;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0}
      button:hover{background:#ea580c}
    </style></head><body>
      <div class="h">⏰ 할일 알람 ${todo.time ? '· ' + esc(todo.time) : ''}${remain > 0 ? `<span class="q">대기 ${remain}건</span>` : ''}</div>
      <div class="t">${esc(todo.title)}</div>
      ${todo.note ? `<div class="n">${esc(todo.note)}</div>` : ''}
      <button onclick="window.close()">확인</button>
    </body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // data URL은 ready-to-show가 안 뜨는 경우가 있어, did-finish-load + 폴백 타이머로 확실히 표시
    let shown = false;
    const reveal = async () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      try {
        const h = await win.webContents.executeJavaScript('document.body.scrollHeight').catch(() => 0);
        if (h) {
          const newH = Math.min(Math.max(Math.ceil(h) + 4, 120), Math.floor(wa.height * 0.6));
          win.setBounds({ x: wa.width - W - 16, y: Math.max(16, wa.height - newH - 16), width: W, height: newH });
        }
      } catch { /* ignore */ }
      if (!win.isDestroyed()) { win.show(); win.moveTop(); }
    };
    win.webContents.once('did-finish-load', reveal);
    win.once('ready-to-show', reveal);
    setTimeout(reveal, 1200);
    // 확인(창 닫힘) → 다음 알람 표시. 자동 닫힘 없음.
    win.on('closed', () => { currentAlarmWin = null; setTimeout(showNextAlarm, 100); });
  } catch { currentAlarmWin = null; }
}

const firedAlarms = new Set(); // `${id}_${yyyy-MM-dd}` — 하루 1회 발사 보장
let alarmTimer = null;
let alarmBlockerId = null;
function checkAlarms() {
  let todos;
  try { todos = loadTodos(); } catch { return; }
  if (!todos.length) return;
  const now = new Date();
  todos.forEach(t => {
    const fire = todoAlarmDueNow(t, now);
    if (!fire) return;
    firedAlarms.add(fire.key);
    // 1) 데스크톱 팝업 창 (항상 위) — 한 번에 하나씩, 확인 전까지 유지 + 대기열
    enqueueAlarm(t);
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
    migrateLegacyTodosOnce();
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
    if (patch.gistId !== undefined) {
      const next = String(patch.gistId).trim();
      if (next !== c.gistId) c.etag = ''; // 다른 Gist를 가리키면 이전 ETag는 무의미하므로 초기화
      c.gistId = next;
    }
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

  // ── 인쇄 (가로 방향 강제) ──
  // Windows Electron 인쇄 대화상자는 landscape 옵션을 무시하고 프린터 기본(세로)을
  // 따르는 문제가 있다. 그래서 가로·배경색이 확정된 A4 PDF로 렌더링한 뒤 기본
  // 뷰어로 열어준다 — 뷰어에서 그대로 인쇄하면 항상 가로로 출력된다.
  ipcMain.handle('print:doc', async (_e, options = {}) => {
    try {
      const win = BrowserWindow.getFocusedWindow() || mainWin;
      if (!win || win.isDestroyed()) return { ok: false, error: 'no-window' };
      const data = await win.webContents.printToPDF({
        landscape: options.landscape !== false,
        printBackground: true,
        pageSize: options.pageSize || 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      const file = path.join(app.getPath('temp'), `모니터링일정_${Date.now()}.pdf`);
      fs.writeFileSync(file, data);
      const err = await shell.openPath(file);
      if (err) return { ok: false, error: err };
      return { ok: true, file };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 내보내기 ──
  // 일정을 엑셀 표 서식(예: "표 스타일 보통 16")이 적용된 진짜 .xlsx 표로 내보내기.
  // exceljs(+jszip 등 의존성)는 npm run build:xlsx로 electron/xlsx-export.bundle.cjs
  // 하나의 파일에 미리 번들링해두고 그것만 불러온다 — 패키징된 설치본에 node_modules가
  // 그대로 포함되는지 여부에 의존하지 않아, 배포본에서 "Cannot find module" 오류 없이
  // 항상 동작한다.
  ipcMain.handle('export:scheduleExcelTable', async (_e, { defaultName, sheetName, tableStyle, columns, rows } = {}) => {
    try {
      // 배포본: 번들 파일 사용. 개발 환경(번들 미생성)에서는 node_modules의 exceljs로 폴백.
      let buildScheduleExcelBuffer;
      try {
        ({ buildScheduleExcelBuffer } = require('./xlsx-export.bundle.cjs'));
      } catch {
        ({ buildScheduleExcelBuffer } = require('./xlsx-export.src.js'));
      }
      const buffer = await buildScheduleExcelBuffer({ sheetName, tableStyle, columns, rows });

      const win = BrowserWindow.getFocusedWindow() || mainWin;
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: defaultName || 'export.xlsx',
        filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      fs.writeFileSync(filePath, buffer);
      return { ok: true, filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 교정 첨부파일 ──
  const calibFilesDir = () => {
    const d = path.join(app.getPath('userData'), 'calib-files');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
    return d;
  };
  ipcMain.handle('calibFile:save', (_e, { name, dataBase64 } = {}) => {
    try {
      const safe = String(name || 'file').replace(/[^\w.\-가-힣 ()]/g, '_');
      // 입력한 이름 그대로 저장(랜덤 접두사 없음). 이름이 겹치면 (2),(3)… 을 붙여 덮어쓰기 방지.
      const dir = calibFilesDir();
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      let full = path.join(dir, safe), n = 2;
      while (fs.existsSync(full)) { full = path.join(dir, `${stem} (${n})${ext}`); n++; }
      fs.writeFileSync(full, Buffer.from(dataBase64, 'base64'));
      return { ok: true, path: full, name: path.basename(full) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('calibFile:open', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '파일을 찾을 수 없습니다' };
      const r = await shell.openPath(filePath);
      return { ok: !r, error: r || undefined };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('calibFile:reveal', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '파일을 찾을 수 없습니다' };
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

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

  // ── 관리자 잠금 (일정 편집 권한) ──
  ipcMain.handle('admin:hasPassword', () => !!loadData().adminPasswordHash);
  ipcMain.handle('admin:isUnlocked', () => adminUnlocked);
  ipcMain.handle('admin:setPassword', (_e, password) => {
    if (!password) return { ok: false, error: '비밀번호를 입력하세요' };
    const data = loadData();
    data.adminPasswordHash = hashPassword(password);
    saveData(data);
    adminUnlocked = true;
    broadcastAdminUnlocked();
    return { ok: true };
  });
  ipcMain.handle('admin:unlock', (_e, password) => {
    const data = loadData();
    if (!data.adminPasswordHash) return { ok: false, error: '설정된 관리자 비밀번호가 없습니다' };
    if (hashPassword(password) !== data.adminPasswordHash) return { ok: false, error: '비밀번호가 올바르지 않습니다' };
    adminUnlocked = true;
    broadcastAdminUnlocked();
    return { ok: true };
  });
  ipcMain.handle('admin:lock', () => {
    adminUnlocked = false;
    broadcastAdminUnlocked();
    return { ok: true };
  });
  ipcMain.handle('admin:changePassword', (_e, { oldPassword, newPassword } = {}) => {
    if (!newPassword) return { ok: false, error: '새 비밀번호를 입력하세요' };
    const data = loadData();
    if (data.adminPasswordHash && hashPassword(oldPassword) !== data.adminPasswordHash) {
      return { ok: false, error: '현재 비밀번호가 올바르지 않습니다' };
    }
    data.adminPasswordHash = hashPassword(newPassword);
    saveData(data);
    return { ok: true };
  });

  // ── 할일(반복 일정) — 설치본 공유 데이터가 아닌 이 PC 로컬 파일에서 관리 ──
  ipcMain.handle('todos:getAll', () => loadTodos());
  ipcMain.handle('todos:upsert', (_e, todo) => {
    const todos = loadTodos();
    if (todo.id) {
      const i = todos.findIndex(t => t.id === todo.id);
      if (i >= 0) todos[i] = todo; else todos.push(todo);
      // 알람 시간을 수정했으면 오늘자 발사 기록을 지워 새 시간에 다시 울리게 한다
      firedAlarms.forEach(k => { if (k.startsWith(todo.id + '_')) firedAlarms.delete(k); });
    } else {
      todo.id = newId();
      if (!todo.completedDates) todo.completedDates = [];
      todos.push(todo);
    }
    saveTodos(todos);
    // 방금 저장한 알람이 이미 지난 시각이면 바로 표시
    setTimeout(() => { try { checkAlarms(); } catch { /* ignore */ } }, 500);
    return todo;
  });
  ipcMain.handle('todos:delete', (_e, id) => {
    saveTodos(loadTodos().filter(t => t.id !== id));
    return true;
  });
  ipcMain.handle('todos:toggleDone', (_e, id, dateStr) => {
    const todos = loadTodos();
    const t = todos.find(x => x.id === id);
    if (t) {
      if (!t.completedDates) t.completedDates = [];
      const i = t.completedDates.indexOf(dateStr);
      if (i >= 0) t.completedDates.splice(i, 1); else t.completedDates.push(dateStr);
      saveTodos(todos);
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
  ipcMain.handle('tempSchedules:update', (_e, entry) => {
    const data = loadData();
    const i = data.tempSchedules.findIndex(t => t.id === entry.id);
    if (i >= 0) { data.tempSchedules[i] = { ...data.tempSchedules[i], ...entry }; saveData(data); return data.tempSchedules[i]; }
    return null;
  });
}
