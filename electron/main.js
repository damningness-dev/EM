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
    const req = mod.get(target, { headers: {
      'User-Agent': 'em-updater/1.0',
      'Cache-Control': 'no-cache, no-store',
      'Pragma': 'no-cache',
    }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve(httpGet(res.headers.location));
      } else if (res.statusCode === 304 && !_bustCache) {
        res.resume();
        resolve(httpGet(url, true));
      } else {
        resolve(res);
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('요청 시간 초과 (20초) — 네트워크 상태를 확인하세요')); });
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
      // 새 버전 안내는 앱 내부 UpdateNotifier 카드로만 표시한다(윈도우 트레이
      // 풍선 팝업은 거슬린다는 피드백에 따라 제거).
      sendStatus({ type: 'available', version: meta.version });
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
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        // meta.json도 매 시도마다 새로 받는다 — "latest" 릴리즈가 두 배포가 짧은
        // 간격으로 이어질 때(예: 커밋 두 개를 연달아 푸시) 도중에 바뀌면, meta는
        // 예전 것을 쓰고 asar만 새로 받아 체크섬이 계속 어긋나는 문제를 막는다.
        const meta = await fetchJSON(META_URL);
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

// 연간계획(AHU 유지보수) 화면의 기본 AHU 목록 — 사용자가 화면에서 추가한 AHU는
// annualPlanAhus에 저장되어 공유 데이터(em-data.json)로 함께 동기화된다.
const DEFAULT_AHUS = ['AHU-01', 'AHU-02', 'AHU-15', 'AHU-16', 'AHU-19', 'AHU-31', 'AHU-32', 'AHU-33', 'AHU-34', 'AHU-42', 'AHU-43'];

// 사용점 관리 대분류별 소분류 기본 목록 — 관리자가 화면에서 추가·수정할 수 있다.
const DEFAULT_USAGE_POINT_CATEGORIES = { '공조': [], '가스': [], '용수': [], '기타': [] };

// 기본 관리자 계정을 처음 만들 때 허용할 탭 — App.jsx의 MENU와 같은 id 목록.
const DEFAULT_ADMIN_TABS = ['dashboard', 'todo', 'calendar', 'status', 'gantt', 'annual', 'calibration', 'usagepoints', 'weeklyduty'];

// 주간근무 화면 기본값 — 사용자가 올려준 "주간근무" 시트 내용을 그대로 옮겨 심어
// 처음부터 실제 로테이션이 채워진 상태로 시작한다. 이후 관리자가 화면에서
// 업무·주차·담당자를 자유롭게 추가·수정·삭제할 수 있다.
const DEFAULT_WEEKLY_DUTY = {
  // 관리자가 추가·삭제하는 직원 목록 — 담당자 배정은 이 목록에서 골라서 지정한다.
  staff: ['김찬일', '이동현', '박지연'],
  // "1주차"가 시작하는 월요일(기준일). 오늘이 기준일로부터 몇 주 지났는지 계산해
  // weeks.length로 나눈 나머지로 "이번 주가 몇 주차인지" 자동 판정한다.
  referenceDate: '2026-08-03',
  alarmTime: '09:00',
  autoAlarm: true, // 켜두면 매일 자동으로 오늘 담당자의 할일에 알람을 등록한다
  weeks: ['1주차', '2주차', '3주차', '4주차', '5주차'],
  dailyTasks: [
    { id: 'd1', name: '모니터링 라벨 일지 출력', assignments: ['김찬일', '이동현', '박지연', '김찬일', '이동현'] },
    { id: 'd2', name: '세탁일지 작성', assignments: ['김찬일', '이동현', '박지연', '김찬일', '이동현'] },
    { id: 'd3', name: '배지 준비하기(라벨 붙이기)', assignments: ['김찬일, 박지연', '이동현, 김찬일', '박지연, 이동현', '김찬일, 박지연', '이동현, 김찬일'] },
    { id: 'd4', name: '기기사용기록서 작성(부유입자측정기, 부유균포집기)', assignments: ['김찬일, 박지연', '이동현, 김찬일', '박지연, 이동현', '김찬일, 박지연', '이동현, 김찬일'] },
    { id: 'd5', name: '개인위생점검표 작성', assignments: ['박지연', '김찬일', '이동현', '박지연', '김찬일'] },
    { id: 'd6', name: 'Rawdata 파일 정리', assignments: ['박지연', '김찬일', '이동현', '박지연', '김찬일'] },
    { id: 'd7', name: '인큐베이터 온습도 작성 오전/오후(2회)', assignments: ['이동현', '박지연', '김찬일', '이동현', '박지연'] },
    { id: 'd8', name: '제조용수 모니터링 일지 출력 채취 및 회수', assignments: ['이동현', '박지연', '김찬일', '이동현', '박지연'] },
    { id: 'd9', name: '다음날 용수일정 준비하기', assignments: ['이동현', '박지연', '김찬일', '이동현', '박지연'] },
    { id: 'd10', name: '준비실 청소 및 정리정돈(전기코드)', assignments: ['이동현', '박지연', '김찬일', '이동현', '박지연'] },
  ],
  weeklyTasks: [
    { id: 'w1', name: '인큐베이터 데이터 출력', assignments: ['박지연', '김찬일', '이동현', '박지연', '김찬일'] },
  ],
  monthlyTasks: [
    { id: 'm1', name: '인큐베이터 온습도 일지확인 후 출력', assignee: '이동현' },
    { id: 'm2', name: '소독제 교체일지 확인', assignee: '박지연' },
    { id: 'm3', name: '개인위생점검표, 기기사용기록서, 세탁일지 출력', assignee: '김찬일' },
  ],
  notes: '',
};

function getDataPath() {
  return path.join(app.getPath('userData'), 'em-data.json');
}

function loadData() {
  const p = getDataPath();
  if (!fs.existsSync(p)) {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [], annualPlanAhus: [...DEFAULT_AHUS], usagePoints: [], usagePointCategories: { ...DEFAULT_USAGE_POINT_CATEGORIES }, guestAllowedTabs: null, weeklyDuty: JSON.parse(JSON.stringify(DEFAULT_WEEKLY_DUTY)) };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data.groups) data.groups = [];
    if (!data.holidays) data.holidays = [];
    if (!data.completions) data.completions = [];
    if (!data.tempSchedules) data.tempSchedules = [];
    if (!data.blockedDates) data.blockedDates = [];
    if (!data.annualPlanAhus) data.annualPlanAhus = [...DEFAULT_AHUS];
    if (!data.memberAccounts) data.memberAccounts = [];
    if (!data.scheduleAssignees) data.scheduleAssignees = {};
    if (!data.usagePoints) data.usagePoints = [];
    if (!data.usagePointCategories) data.usagePointCategories = { ...DEFAULT_USAGE_POINT_CATEGORIES };
    // 로그인하지 않았을 때 보이는 메뉴 — null(기본값)이면 지금까지처럼 전체 메뉴가 보이고,
    // 배열이면 그 탭들만 보인다(계정별 allowedTabs와 같은 방식, 로그인 전 상태에 적용).
    if (!('guestAllowedTabs' in data)) data.guestAllowedTabs = null;
    if (!data.weeklyDuty) data.weeklyDuty = JSON.parse(JSON.stringify(DEFAULT_WEEKLY_DUTY));
    // 이전 버전에서 이미 weeklyDuty가 있었지만 직원 목록·기준일 같은 새 필드가
    // 없을 수 있다 — 없는 필드만 기본값으로 채운다(기존 업무·배정은 그대로 둠).
    if (!Array.isArray(data.weeklyDuty.staff)) data.weeklyDuty.staff = [...DEFAULT_WEEKLY_DUTY.staff];
    if (!data.weeklyDuty.referenceDate) data.weeklyDuty.referenceDate = DEFAULT_WEEKLY_DUTY.referenceDate;
    if (!data.weeklyDuty.alarmTime) data.weeklyDuty.alarmTime = DEFAULT_WEEKLY_DUTY.alarmTime;
    if (typeof data.weeklyDuty.autoAlarm !== 'boolean') data.weeklyDuty.autoAlarm = true;
    return data;
  } catch {
    return { calibration: [], zones: [], monitoringData: {}, annualPlan: {}, groups: [], holidays: [], completions: [], tempSchedules: [], blockedDates: [], annualPlanAhus: [...DEFAULT_AHUS], usagePoints: [], usagePointCategories: { ...DEFAULT_USAGE_POINT_CATEGORIES }, guestAllowedTabs: null, weeklyDuty: JSON.parse(JSON.stringify(DEFAULT_WEEKLY_DUTY)) };
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

// 로그인이 곧 관리자 권한을 겸하는 구조라, 관리자 계정이 하나도 없으면 아무도
// 관리자로 로그인할 수 없어 앱이 잠긴 채로 막힌다. 그런 계정이 전혀 없을 때만
// 기본 관리자 계정을 한 번 만들어 둔다(이미 있으면 손대지 않음).
function seedDefaultAdminOnce() {
  const data = loadData();
  if (!data.memberAccounts) data.memberAccounts = [];
  if (data.memberAccounts.some(m => m.isAdmin)) return;
  const existing = data.memberAccounts.find(m => m.username === '최기훈');
  if (existing) {
    existing.isAdmin = true;
    if (!existing.allowedTabs || !existing.allowedTabs.length) existing.allowedTabs = [...DEFAULT_ADMIN_TABS];
  } else {
    data.memberAccounts.push({
      id: newId(), username: '최기훈', passwordHash: hashPassword('123456'),
      allowedTabs: [...DEFAULT_ADMIN_TABS], isAdmin: true,
    });
  }
  // 앱이 스스로 심는 기본값이라 "올려야 할 로컬 변경"으로 잡지 않는다 — 그렇게
  // 잡으면 토큰이 없는(읽기 전용) PC가 첫 실행부터 내려받기가 막혀버린다.
  saveData(data, { local: false });
}

// local:false는 "이 PC 사용자가 편집한 게 아니다"라는 뜻 — 동기화로 내려받은
// 내용을 반영하거나 앱이 스스로 초기값을 심는 경우다. 이때는 아직 못 올린 로컬
// 변경으로 표시하지 않는다(아래 markPendingLocal 설명 참고).
function saveData(data, { local = true } = {}) {
  const clean = { ...data };
  delete clean.todos; // 할일은 todos-local.json에서 별도 관리
  delete clean.users; // 사용자 명부(구 기능) — 관리자 비밀번호로 대체됨
  fs.writeFileSync(getDataPath(), JSON.stringify(clean, null, 2), 'utf-8');
  if (local) markPendingLocal();
}

function newId() {
  return crypto.randomUUID();
}

// ─── 관리자 권한 (일정 편집 권한) ──────────────────────────────────────────────
// 예전엔 로그인과 별개인 단일 공유 비밀번호로 편집 권한을 열었지만, 이제는 로그인
// 계정 하나로 합쳐졌다 — 로그인한 계정에 isAdmin이 있으면 그 계정으로 로그인한
// 것 자체가 곧 관리자 권한이다(로그아웃하면 자동으로 잠김). computeAdminUnlocked()는
// 아래 currentMemberId 선언 이후에 실제로 정의된다.
function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw || '')).digest('hex');
}
function broadcastAdminUnlocked() {
  const unlocked = computeAdminUnlocked();
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('admin:unlockChanged', unlocked); });
}

// ─── 앱 환경설정 / 부팅 시 자동 시작 ──────────────────────────────────────────

function prefsPath() { return path.join(app.getPath('userData'), 'app-prefs.json'); }
function loadPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf-8')) || {}; } catch { return {}; } }
function savePrefs(p) { try { fs.writeFileSync(prefsPath(), JSON.stringify(p, null, 2)); } catch { /* ignore */ } }

// 완료되지 않은 할일 알람을 몇 분마다 다시 울릴지 — 이 PC에만 저장되는 설정.
// 0이면 리마인드 꺼짐(예전처럼 하루 1회만 울림). 기본 10분.
function getReminderIntervalMin() {
  const p = loadPrefs();
  return Number.isFinite(p.reminderIntervalMin) ? p.reminderIntervalMin : 10;
}

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

// 이 PC에서 편집했지만 아직 공유 Gist에 못 올린 변경이 있는지 표시한다.
// syncPull()은 내려받은 내용으로 데이터 파일을 통째로 덮어쓰기 때문에, 이 표시가
// 없으면 "저장은 됐는데 몇 분 뒤 조용히 사라지는"(=자동 동기화가 덮어씀) 데이터
// 유실이 생긴다. 표시가 있으면 내려받기 전에 먼저 올려서 지킨다.
function markPendingLocal() {
  try {
    const cfg = loadSyncConfig();
    if (!cfg.gistId) return;           // 공유를 안 쓰는 PC는 덮어쓸 원격이 없다
    if (!cfg.pendingLocalSince) {      // 이미 표시돼 있으면 시각을 갱신하지 않는다
      cfg.pendingLocalSince = new Date().toISOString();
      saveSyncConfig(cfg);
    }
    schedulePush();
  } catch { /* ignore */ }
}

// 어느 화면에서 저장하든 잠시 뒤 자동으로 공유에 올린다. 화면마다 업로드 호출을
// 넣는 방식은 빠뜨리기 쉬워(연간계획·월간모니터링·발주그룹관리가 실제로 빠져 있었다)
// 데이터 저장 지점 한 곳에서 공통으로 처리한다. 연속 저장은 한 번으로 묶는다.
const PUSH_DEBOUNCE_MS = 8000;
let pendingPushTimer = null;
function schedulePush() {
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = setTimeout(() => {
    pendingPushTimer = null;
    try {
      const cfg = loadSyncConfig();
      if (!cfg.gistId || !cfg.pendingLocalSince) return;
      if (!effectiveToken(cfg)) return; // 토큰이 없으면 사이드바 경고로 이미 알리고 있다
      syncUpload().catch(() => { /* 실패해도 표시는 남아 다음 기회에 다시 시도 */ });
    } catch { /* ignore */ }
  }, PUSH_DEBOUNCE_MS);
}

// 로그인 계정별 GitHub 토큰 — 관리자가 "사용자 계정 관리"에서 각 계정에 미리
// 발급해 붙여두면 memberAccounts(공유 데이터)에 함께 저장되어 다른 PC로도
// 동기화된다. 그 계정으로 로그인한 PC는 별도 설정 없이 그 토큰을 자동으로 쓴다.
// currentMemberId는 이 PC에서 지금 로그인한 계정을 렌더러가 알려준 값(비로그인 시 null).
let currentMemberId = null;
function computeAdminUnlocked() {
  if (!currentMemberId) return false;
  const m = (loadData().memberAccounts || []).find(mm => mm.id === currentMemberId);
  return !!m?.isAdmin;
}
// 계정별 토큰은 공유 데이터(em-data.json)에 담겨 그대로 공유 Gist에 업로드된다.
// 원문(ghp_... 등)을 그대로 저장하면 GitHub가 자기 플랫폼(Gist 포함) 안에서
// 자기 토큰 형식이 노출된 것을 자동 탐지해 "유출된 토큰"으로 간주하고 즉시
// 폐기해버린다(실제로 겪은 문제). Gist 안에는 원문이 절대 보이지 않도록 저장 시
// 형태를 바꾸고, 실제 GitHub API 호출 직전에만 원래 값으로 복원한다. 이건 진짜
// 암호화가 아니라 자동 스캐너의 패턴 탐지만 피하기 위한 최소한의 가공이다 —
// 이 앱의 신뢰 경계(공유 데이터에 이미 비밀번호 해시 등도 함께 있음)는 그대로다.
const TOKEN_OBFUSCATE_KEY = 'em-shared-data-token-guard';
function obfuscateToken(raw) {
  if (!raw) return raw;
  const buf = Buffer.from(String(raw), 'utf-8');
  const key = Buffer.from(TOKEN_OBFUSCATE_KEY, 'utf-8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return 'x1:' + out.toString('base64');
}
function deobfuscateToken(stored) {
  if (!stored || typeof stored !== 'string') return stored;
  if (!stored.startsWith('x1:')) return stored; // 이전 버전에 평문으로 저장된 토큰과 호환
  try {
    const buf = Buffer.from(stored.slice(3), 'base64');
    const key = Buffer.from(TOKEN_OBFUSCATE_KEY, 'utf-8');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return out.toString('utf-8');
  } catch { return stored; }
}
function effectiveToken(cfg) {
  if (currentMemberId) {
    const m = (loadData().memberAccounts || []).find(mm => mm.id === currentMemberId);
    if (m?.token) return deobfuscateToken(m.token);
  }
  return cfg.token;
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
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 20000 }, (res) => {
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
    // 네트워크 문제(방화벽·프록시 등)로 응답이 아예 안 오면 요청이 끝없이 매달려
    // 있을 수 있다 — 20초 안에 응답이 없으면 명확한 오류로 끝내서 화면이 "아무
    // 반응 없이" 멈춰 있는 것처럼 보이지 않게 한다.
    req.on('timeout', () => { req.destroy(new Error('요청 시간 초과 (20초) — 네트워크 상태를 확인하세요')); });
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
async function syncPull(force, { discardLocal = false } = {}) {
  let cfg = loadSyncConfig();
  if (!cfg.gistId) return { ok: false, error: 'Gist ID가 설정되지 않았습니다' };

  // 아직 못 올린 이 PC의 변경이 있으면 먼저 올려서 지킨 뒤에 내려받는다.
  // 그냥 내려받으면 아래 saveData()가 데이터 파일을 원격 내용으로 통째로
  // 덮어써서 그 변경이 흔적 없이 사라진다 — "분명 저장했는데 나중에 보면
  // 없어져 있다 / 다른 PC와 공유도 안 된다"로 나타나던 문제의 원인이다.
  let keepLocalChanges = false;
  if (cfg.pendingLocalSince && !discardLocal) {
    const up = await syncUpload();
    if (up?.ok) {
      cfg = loadSyncConfig(); // 업로드가 갱신한 lastSyncedAt/etag를 다시 읽는다
    } else {
      // 올릴 수 없으면(토큰 없음·만료 등) 내려받기를 멈추는 대신, 내려받은 내용에
      // 이 PC의 변경을 얹어서 반영한다. 멈추면 다른 PC의 변경을 못 받고, 그냥
      // 덮어쓰면 이 PC 작업이 사라지는데, 합치면 둘 다 잃지 않는다.
      keepLocalChanges = true;
    }
  }

  sendSyncStatus({ type: 'checking' });
  try {
    const r = await gistFetchData(cfg.gistId, effectiveToken(cfg), cfg.etag);
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
    if (keepLocalChanges) {
      // 올리지 못한 이 PC 변경을 내려받은 내용에 얹는다. 기준 PC면 전체를 합치고,
      // 일반 PC면 사용점만 남긴다(나머지는 기준 PC 내용이 맞으므로).
      const local = loadData();
      parsed = cfg.role === 'admin' ? mergeSharedData(parsed, local) : buildMemberUpload(parsed, local);
    }
    saveData(parsed, { local: false }); // 내려받은 내용 = 원격과 같음 → 올릴 것 없음
    cfg.lastSyncedAt = updatedAt;
    cfg.etag = etag;
    // 아직 못 올린 변경이 남아 있으면 표시를 유지해, 나중에 올릴 수 있게 되면
    // (토큰 등록 등) 그때 자동으로 올라가게 한다.
    if (!keepLocalChanges) delete cfg.pendingLocalSince;
    saveSyncConfig(cfg);
    broadcastDataChanged();
    sendSyncStatus({ type: 'updated', lastSyncedAt: updatedAt });
    return { ok: true, updated: true, updatedAt };
  } catch (err) {
    sendSyncStatus({ type: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

// 공유 데이터는 파일 하나를 통째로 올리는 방식이라, 내가 마지막으로 맞춘 뒤에
// 다른 PC가 먼저 올려놨다면 그대로 덮어쓸 때 그쪽 입력이 통째로 사라진다.
// PC 4대가 서로 다른 데이터를 갖게 된 원인 중 하나다. 그래서 충돌이 감지될 때만
// 목록형 데이터를 id 기준 합집합으로 합쳐서 양쪽 입력을 모두 살린다.
const MERGE_MAP_KEYS = ['monitoringData', 'annualPlan']; // 날짜·구역 키로 나뉜 맵

function mergeListById(remoteList, localList) {
  const a = Array.isArray(remoteList) ? remoteList : [];
  const b = Array.isArray(localList) ? localList : [];
  // id가 있으면 id로, 없으면(문자열 목록 등) 값 자체로 같은 항목인지 판단한다.
  const keyOf = (v) => (v && typeof v === 'object' && v.id != null) ? `id:${v.id}` : `raw:${JSON.stringify(v)}`;
  const map = new Map();
  for (const v of a) map.set(keyOf(v), v);
  for (const v of b) {
    const k = keyOf(v);
    const prev = map.get(k);
    if (prev === undefined) { map.set(k, v); continue; }
    // 양쪽이 같은 항목을 갖고 있으면 더 최근에 수정된 쪽을 남긴다.
    const tPrev = (prev && prev.updatedAt) || '';
    const tNext = (v && v.updatedAt) || '';
    map.set(k, tNext >= tPrev ? v : prev);
  }
  return [...map.values()];
}

function mergeSharedData(remote, local) {
  const out = { ...(remote || {}), ...(local || {}) }; // 설정성 단일 값은 이 PC 기준
  const keys = new Set([...Object.keys(remote || {}), ...Object.keys(local || {})]);
  for (const key of keys) {
    const rv = remote?.[key], lv = local?.[key];
    if (Array.isArray(rv) || Array.isArray(lv)) out[key] = mergeListById(rv, lv);
    else if (MERGE_MAP_KEYS.includes(key)) out[key] = { ...(rv || {}), ...(lv || {}) };
  }
  return out;
}

// GitHub 오류를 사용자가 바로 조치할 수 있는 말로 바꾼다. 특히 Gist는 "만든
// 계정"만 수정할 수 있어서, 다른 GitHub 계정의 토큰으로 올리려 하면 404가 난다 —
// PC마다 각자 다른 Gist가 만들어져 데이터가 갈라지는 흔한 원인이라 명확히 알린다.
function explainGistError(err) {
  const m = String(err?.message || '');
  if (/HTTP 401/.test(m)) return `GitHub 인증 실패 — 토큰이 만료·폐기되었습니다. 새 토큰을 발급해 등록하세요. (${m})`;
  if (/HTTP 404/.test(m)) return `이 Gist를 수정할 수 없습니다 — Gist ID가 맞는지, 그리고 등록된 토큰이 그 Gist를 만든 GitHub 계정의 토큰인지 확인하세요. Gist는 만든 계정만 수정할 수 있습니다. (${m})`;
  if (/HTTP 403/.test(m)) return `권한이 없습니다 — Classic 토큰에 gist 권한이 켜져 있는지 확인하세요. (${m})`;
  return m;
}

// 모든 PC가 함께 쓰는(누구나 추가·수정하고 서로 공유하는) 항목.
// 사용점 관리만 여기에 해당한다. 나머지(월간모니터링·구역별현황·간트차트·연간계획·
// 교정관리·주간근무·계정 설정 등)는 "기준 PC"(sync-config의 role='admin')의 내용이
// 공유 기준이 되고, 일반 PC가 올릴 때는 건드리지 않는다.
const COLLAB_KEYS = ['usagePoints'];

// 일반 PC가 올릴 내용을 만든다 — 원격(기준 PC가 올린 내용)을 그대로 두고,
// 함께 쓰는 항목만 이 PC 내용을 합쳐 넣는다. 이렇게 해야 일반 PC가 사용점을
// 추가해도 기준 PC가 관리하는 다른 자료를 덮어쓰지 않는다.
function buildMemberUpload(remoteData, localData) {
  const out = { ...remoteData };
  for (const key of COLLAB_KEYS) out[key] = mergeListById(remoteData?.[key], localData?.[key]);
  // 첨부파일 보관용 Gist ID는 한 번 정해지면 계속 써야 하므로 있는 쪽을 남긴다.
  if (!out.attachGistId && localData?.attachGistId) out.attachGistId = localData.attachGistId;
  return out;
}

// 로컬 → 원격 업로드.
// allowCreate: Gist ID가 없을 때 새로 만들어도 되는지(명시적으로 "새 공유 만들기"를
//   눌렀을 때만 true). 예전엔 항상 만들어서, PC마다 자기만의 Gist가 생겨 데이터가
//   갈라지는 문제가 있었다.
// overwriteRemote: 원격을 이 PC 내용으로 통째로 덮어쓴다("이 PC 기준으로 통일").
async function syncUpload({ allowCreate = false, overwriteRemote = false } = {}) {
  const cfg = loadSyncConfig();
  const token = effectiveToken(cfg);
  if (!token) return { ok: false, error: '업로드하려면 GitHub 토큰이 필요합니다' };
  const isBasePC = cfg.role === 'admin'; // 이 PC가 기준(관리자) PC인가
  sendSyncStatus({ type: 'uploading' });
  try {
    let localData = loadData();
    let gistId = cfg.gistId, updatedAt, etag, merged = false;
    if (gistId) {
      if (!overwriteRemote) {
        // 올리기 직전 원격 상태 확인.
        // - 기준 PC: 그 사이 원격이 바뀌었으면(다른 PC가 사용점을 추가했을 수 있으므로)
        //   덮어쓰지 않고 합친다.
        // - 일반 PC: 항상 원격을 바탕으로 삼고 사용점만 얹는다.
        const remote = await gistFetchData(gistId, token);
        let parsed = null;
        if (!remote.notModified) {
          try { parsed = JSON.parse(remote.content); } catch { /* 형식 오류면 합치지 않는다 */ }
        }
        if (parsed && typeof parsed === 'object') {
          if (!isBasePC) {
            localData = buildMemberUpload(parsed, localData);
            saveData(localData, { local: false }); // 올린 내용과 이 PC를 일치시킨다
            merged = true;
          } else if (remote.updatedAt !== cfg.lastSyncedAt) {
            localData = mergeSharedData(parsed, localData);
            saveData(localData, { local: false }); // 합친 결과를 이 PC에도 반영
            merged = true;
          }
        }
      }
      const r = await ghRequest('PATCH', `https://api.github.com/gists/${gistId}`, {
        token, body: { files: { [GIST_FILE]: { content: JSON.stringify(localData, null, 2) } } },
      });
      updatedAt = r.json.updated_at; etag = r.etag;
    } else {
      if (!allowCreate) {
        const msg = '공유 Gist ID가 설정되지 않았습니다 — 다른 PC와 똑같은 Gist ID를 입력하세요. (새로 시작하려면 설정에서 "새 공유 만들기")';
        sendSyncStatus({ type: 'error', message: msg });
        return { ok: false, error: msg };
      }
      const r = await ghRequest('POST', 'https://api.github.com/gists', {
        token,
        body: { description: '환경 모니터링 공유 일정 데이터', public: false, files: { [GIST_FILE]: { content: JSON.stringify(localData, null, 2) } } },
      });
      gistId = r.json.id; updatedAt = r.json.updated_at; etag = r.etag;
    }
    cfg.gistId = gistId; cfg.lastSyncedAt = updatedAt; cfg.etag = etag || '';
    delete cfg.pendingLocalSince; // 올렸으므로 이 PC에만 있는 변경은 이제 없다
    saveSyncConfig(cfg);
    if (merged) broadcastDataChanged(); // 합쳐진 내용이 화면에 바로 보이게
    sendSyncStatus({ type: 'uploaded', lastSyncedAt: updatedAt, merged });
    return { ok: true, gistId, updatedAt, merged };
  } catch (err) {
    const msg = explainGistError(err);
    sendSyncStatus({ type: 'error', message: msg });
    return { ok: false, error: msg };
  }
}

// 자동 동기화 최소 주기.
// 토큰이 있으면 인증 요청이라 계정당 시간당 5,000회를 쓸 수 있고, 변경이 없을 때
// 돌아오는 304 응답은 아예 한도에 포함되지 않는다 — 1분 주기도 충분히 여유롭다.
// 토큰이 없는 PC는 같은 IP에서 비인증 시간당 60회를 나눠 쓰므로 3분을 유지한다.
function minIntervalMin(cfg) {
  return effectiveToken(cfg) ? 1 : 3;
}

let syncTimer = null;
function restartSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = loadSyncConfig();
  if (cfg.autoSync && cfg.gistId) {
    // 너무 짧게 저장된 값은(설정창을 다시 안 열어도) 자동으로 안전한 값으로 올려준다.
    const safeIntervalMin = Math.max(minIntervalMin(cfg), cfg.intervalMin || 5);
    if (safeIntervalMin !== cfg.intervalMin) { cfg.intervalMin = safeIntervalMin; saveSyncConfig(cfg); }
    const ms = safeIntervalMin * 60 * 1000;
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

// 현재 로그인한 계정의 사용자이름 — 주간근무 담당자 전용 할일을 그 사람에게만
// 울리게 하는 데 쓴다. 로그인 안 했으면 null(그런 할일은 아무한테도 안 울림).
function currentLoggedInUsername() {
  if (!currentMemberId) return null;
  const m = (loadData().memberAccounts || []).find(mm => mm.id === currentMemberId);
  return m?.username || null;
}

// 지금(now) 이 todo의 알람을 울려야 하면 { key, occDay } 반환, 아니면 null.
function todoAlarmDueNow(todo, now, currentUsername) {
  const a = todoAlarm(todo);
  if (!a || !a.enabled || !a.time) return null;
  // 주간근무에서 자동 등록된 할일은 배정된 본인이 로그인해 있을 때만 울린다.
  if (todo.weeklyDutyAssignee && todo.weeklyDutyAssignee !== currentUsername) return null;
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
    const lastFired = firedAlarms.get(key);
    if (lastFired != null) {
      // 이미 한 번 울린 알람 — 완료 처리 전까지 리마인드 주기마다 다시 울린다.
      // 주기가 0(꺼짐)이면 예전처럼 하루 1회만 울리고 끝낸다.
      const intervalMin = getReminderIntervalMin();
      if (!intervalMin) continue;
      if (now.getTime() - lastFired < intervalMin * 60000) continue;
    }
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
      // showInactive() — 알람 창은 보이고 클릭도 되지만 키보드 포커스는 뺏지 않는다.
      // show()를 쓰면 다른 화면(예: 주간근무 입력 중)에서 타이핑하던 포커스가
      // 갑자기 이 알람 창으로 넘어가 버려, 확인을 누르기 전까지 입력이 안 먹히는
      // 것처럼 보이는 문제가 있었다.
      if (!win.isDestroyed()) { win.showInactive(); win.moveTop(); }
    };
    win.webContents.once('did-finish-load', reveal);
    win.once('ready-to-show', reveal);
    setTimeout(reveal, 1200);
    // 확인(창 닫힘) → 다음 알람 표시. 자동 닫힘 없음.
    win.on('closed', () => { currentAlarmWin = null; setTimeout(showNextAlarm, 100); });
  } catch { currentAlarmWin = null; }
}

// ─── 주간근무 → 할일 알람 자동 등록 ────────────────────────────────────────────
// 주간근무에서 오늘 담당인 업무·담당자를 매일 자동으로 "할일"에 반영해 알람이
// 울리게 한다. 할일은 PC별 로컬 파일(todos-local.json)이라 이 동기화도 PC마다
// 각자 돌아간다 — 그 PC를 쓰는 사람이 오늘 담당자 알람을 보게 하려는 목적.
function computeCurrentWeekIndex(duty, now) {
  if (!duty?.referenceDate || !duty.weeks?.length) return null;
  const ref = new Date(duty.referenceDate + 'T00:00:00');
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - ref) / 86400000);
  if (diffDays < 0) return null; // 기준일 이전이면 아직 로테이션 시작 전
  const weekNum = Math.floor(diffDays / 7);
  return weekNum % duty.weeks.length;
}
let lastWeeklyDutySyncDate = null;
function syncWeeklyDutyTodos() {
  const data = loadData();
  const duty = data.weeklyDuty;
  if (!duty || duty.autoAlarm === false) return;
  const now = new Date();
  const wi = computeCurrentWeekIndex(duty, now);
  if (wi == null) return;
  const todayStr = ymd(now);
  const isMonday = now.getDay() === 1;
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const isMonthEdge = now.getDate() === 1 || now.getDate() === lastDayOfMonth;
  const defaultAlarmTime = duty.alarmTime || '09:00';

  let todos;
  try { todos = loadTodos(); } catch { return; }
  const activeSources = new Set();

  // 담당자별로 각각 따로 할일을 만든다 — 제목엔 이름 대신 분류만 넣고
  // (weeklyDutyAssignee로 표시해두면) 로그인한 본인에게만 보이고 울리게 할 수 있다.
  function upsertDutyTodo(sourceId, category, taskName, assigneeField, alarmTime) {
    const names = String(assigneeField || '').split(',').map(s => s.trim()).filter(Boolean);
    const time = alarmTime || defaultAlarmTime;
    names.forEach(name => {
      const src = `${sourceId}_${name}`;
      activeSources.add(src);
      const title = `[${category}] ${taskName}`;
      const idx = todos.findIndex(t => t.weeklyDutySource === src && t.date === todayStr);
      const alarm = { enabled: true, mode: 'atTime', time, base: 'each' };
      if (idx >= 0) {
        todos[idx] = { ...todos[idx], title, alarm, alarmEnabled: true, time, weeklyDutyAssignee: name };
      } else {
        todos.push({
          id: newId(), title, date: todayStr, due: '', note: '주간근무에서 자동 등록됨',
          repeat: 'none', interval: 1,
          alarm, alarmEnabled: true, time,
          completedDates: [],
          weeklyDutySource: src, weeklyDutyAssignee: name,
        });
      }
    });
  }

  (duty.dailyTasks || []).forEach(t => upsertDutyTodo(`wd_daily_${t.id}`, '일일점검', t.name, t.assignments?.[wi], t.alarmTime));
  if (isMonday) (duty.weeklyTasks || []).forEach(t => upsertDutyTodo(`wd_weekly_${t.id}`, '주간점검', t.name, t.assignments?.[wi], t.alarmTime));
  if (isMonthEdge) (duty.monthlyTasks || []).forEach(t => upsertDutyTodo(`wd_monthly_${t.id}`, '월간점검', t.name, t.assignee, t.alarmTime));

  // 오늘 자동 생성됐던 항목인데 더는 대상이 아니면(업무 삭제·담당자 해제) 정리한다.
  const cleaned = todos.filter(t => !t.weeklyDutySource || t.date !== todayStr || activeSources.has(t.weeklyDutySource));
  saveTodos(cleaned);
}
function maybeSyncWeeklyDutyTodos() {
  const today = ymd(new Date());
  if (today === lastWeeklyDutySyncDate) return;
  lastWeeklyDutySyncDate = today;
  syncWeeklyDutyTodos();
}

const firedAlarms = new Map(); // `${id}_${occDay}_${mode}` → 마지막으로 울린 시각(ms). 리마인드 간격 계산에 씀.
let alarmTimer = null;
let alarmBlockerId = null;
function checkAlarms() {
  let todos;
  try { todos = loadTodos(); } catch { return; }
  if (!todos.length) return;
  const now = new Date();
  const currentUsername = currentLoggedInUsername();
  // 앱이 꺼져 있다가 다시 켜지는 등, 같은 확인 틱에 서로 다른 할일 알람이 한꺼번에
  // 밀려서 울릴 차례가 되면 전부 순서대로 띄우지 않는다 — 가장 최근(마지막) 것만
  // 실제로 알리고, 나머지는 확인 처리만 해서 조용히 넘어간다(팝업이 줄줄이 쌓여
  // "확인"을 여러 번 눌러야 하는 상황 방지).
  const due = [];
  todos.forEach(t => {
    const fire = todoAlarmDueNow(t, now, currentUsername);
    if (fire) due.push({ todo: t, fire });
  });
  if (!due.length) return;
  due.forEach(({ fire }) => firedAlarms.set(fire.key, now.getTime()));
  const t = due[due.length - 1].todo;
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
    try { maybeSyncWeeklyDutyTodos(); } catch { /* ignore */ }
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
    seedDefaultAdminOnce();
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
    return {
      gistId: c.gistId || '', hasToken: !!effectiveToken(c), hasSharedToken: !!c.token,
      autoSync: c.autoSync !== false, intervalMin: c.intervalMin || 5, lastSyncedAt: c.lastSyncedAt || '',
      role: c.role || 'member', requesterName: c.requesterName || '',
      pendingLocal: !!c.pendingLocalSince, // 아직 공유에 못 올린 이 PC만의 변경 여부

    };
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
    // 최소 주기는 토큰 유무에 따라 다르다(minIntervalMin 설명 참고). 토큰 설정이
    // 이번 patch에 함께 올 수 있으므로, 위에서 갱신된 c 기준으로 판단한다.
    if (patch.intervalMin !== undefined) c.intervalMin = Math.max(minIntervalMin(c), parseInt(patch.intervalMin) || 5);
    if (patch.role !== undefined) c.role = patch.role === 'admin' ? 'admin' : 'member';
    if (patch.requesterName !== undefined) c.requesterName = String(patch.requesterName).trim();
    saveSyncConfig(c);
    restartSyncTimer();
    return { ok: true };
  });
  ipcMain.handle('sync:upload', () => syncUpload());
  // 새 공유를 처음 만들 때만 — 실수로 PC마다 각자 Gist가 생기지 않도록 분리했다.
  ipcMain.handle('sync:createGist', () => syncUpload({ allowCreate: true }));
  // "이 PC 데이터를 기준으로 통일" — 원격을 이 PC 내용으로 통째로 덮어쓴다.
  ipcMain.handle('sync:publishLocal', () => syncUpload({ overwriteRemote: true }));
  ipcMain.handle('sync:pull', () => syncPull(true));
  // 이 PC에만 있는 변경을 포기하고 원격 내용으로 맞춘다 — 올릴 수 없어(토큰 없음 등)
  // 내려받기가 계속 막힐 때 빠져나오는 용도. 되돌릴 수 없으므로 화면에서 한 번 더 확인받는다.
  ipcMain.handle('sync:discardLocalAndPull', () => syncPull(true, { discardLocal: true }));

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
      // 파일명은 호출한 화면이 정한다(뷰어 제목/저장 시 기본 이름이 되므로).
      const base = String(options.fileName || '모니터링일정').replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(app.getPath('temp'), `${base}_${Date.now()}.pdf`);
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

  // ── 첨부파일(교정 성적서·사용점 사진 등) ──
  // 화면(카테고리)별로 다운로드 폴더를 분리해 둔다 — 교정관리 첨부파일과
  // 사용점관리 사진이 한 폴더에 섞이지 않도록.
  const CALIB_FILE_CATEGORIES = { calibration: 'calibration', usagepoints: 'usagepoints' };
  const calibFilesDir = (category) => {
    const sub = CALIB_FILE_CATEGORIES[category] || 'calibration';
    const d = path.join(app.getPath('userData'), 'calib-files', sub);
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
    return d;
  };
  // gistKey(예: attach_h1735000000_5.pdf.b64)마다 고유한 캐시 하위 폴더를 두고,
  // 그 안에는 업로드했을 때의 원래 파일명 그대로 저장한다. gistKey로 폴더 위치가
  // 정해지니(같은 파일이면 항상 같은 폴더) 한 번 내려받으면 이후엔 다시 내려받지
  // 않고 이 경로에서 바로 열되, 실제 저장 파일명은 원본과 동일하게 유지된다.
  const attachCacheDir = (category, gistKey) => {
    const dir = path.join(calibFilesDir(category), 'gist-cache', gistKey.replace(/[^\w.\-]/g, '_'));
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  };
  function attachCachePath(category, gistKey, fileName) {
    const safeName = String(fileName || gistKey.replace(/\.b64$/, '')).replace(/[^\w.\-가-힣 ()]/g, '_');
    return path.join(attachCacheDir(category, gistKey), safeName);
  }

  // filePath(로컬 원본) → 이 PC 캐시 → 공유 첨부파일 Gist(다운로드+캐시 저장) 순으로
  // 실제 파일을 찾아 로컬 경로를 반환한다. calibFile:open(외부 뷰어로 열기)과
  // calibFile:resolveImage(앱 안에서 바로 보여주기) 둘 다 이 로직을 함께 쓴다.
  async function resolveAttachmentLocalPath({ filePath, gistKey, fileName, category }) {
    if (filePath && fs.existsSync(filePath)) return { ok: true, path: filePath };
    if (!gistKey) return { ok: false, error: '파일을 찾을 수 없습니다' };
    const cachePath = attachCachePath(category, gistKey, fileName);
    if (fs.existsSync(cachePath)) return { ok: true, path: cachePath };
    const data = loadData();
    if (!data.attachGistId) return { ok: false, error: '파일을 찾을 수 없습니다 (공유된 첨부파일 없음)' };
    const cfg = loadSyncConfig();
    const r = await ghRequest('GET', `https://api.github.com/gists/${data.attachGistId}`, { token: effectiveToken(cfg) || undefined });
    const file = r.json.files && r.json.files[gistKey];
    if (!file) return { ok: false, error: '공유된 첨부파일을 찾을 수 없습니다' };
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const res = await httpGet(file.raw_url);
      content = await new Promise((resolve, reject) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
    }
    fs.writeFileSync(cachePath, Buffer.from(content, 'base64'));
    return { ok: true, path: cachePath };
  }
  function guessImageMime(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
  }

  // 첨부파일 전용 Gist ID 확보(없으면 새로 만들어 공유 데이터에 저장).
  // 성적서 PDF 등 첨부파일을 일정 데이터와 같은 Gist에 넣으면 매번 자동 동기화되는
  // 응답이 커져 느려지고 rate limit도 더 쉽게 소진되므로, 별도 Gist에 두고 "열기"를
  // 누를 때만 필요한 파일 하나만 내려받는다. attachGistId는 짧은 문자열이라 일반
  // em-data.json 동기화에 얹혀도 부담이 없다.
  // 짧은 시간 안에 여러 파일을 연달아 첨부하면 ensureAttachGistId()가 동시에 여러
  // 번 호출될 수 있다. 매번 loadData()로 "아직 없음"을 확인하고 각자 새 Gist를
  // 만들면, 나중에 saveData()하는 쪽이 이기면서 먼저 만든 Gist(와 그 안의 파일)가
  // attachGistId 참조를 잃어 "파일을 찾을 수 없습니다" 오류로 이어진다 — 진행 중인
  // 생성 작업을 재사용해 항상 하나의 Gist만 쓰도록 한다.
  let attachGistIdCreation = null;
  async function ensureAttachGistId() {
    const data = loadData();
    if (data.attachGistId) return data.attachGistId;
    if (!attachGistIdCreation) {
      attachGistIdCreation = (async () => {
        const cfg = loadSyncConfig();
        const token = effectiveToken(cfg);
        if (!token) throw new Error('첨부파일을 공유하려면 GitHub 토큰이 필요합니다');
        const r = await ghRequest('POST', 'https://api.github.com/gists', {
          token,
          body: {
            description: '환경 모니터링 첨부파일(교정 성적서 등) — 삭제하지 마세요',
            public: false,
            files: { 'README.md': { content: '이 Gist는 환경 모니터링 앱의 교정 성적서 등 첨부파일 저장용입니다.' } },
          },
        });
        // 생성이 끝나길 기다리는 동안 다른 경로로 이미 attachGistId가 저장됐을 수
        // 있으니, 최신 데이터를 다시 읽어 그 값이 없을 때만 지금 만든 것을 쓴다.
        const fresh = loadData();
        if (!fresh.attachGistId) { fresh.attachGistId = r.json.id; saveData(fresh); }
        return fresh.attachGistId;
      })();
    }
    try {
      return await attachGistIdCreation;
    } finally {
      attachGistIdCreation = null;
    }
  }

  ipcMain.handle('calibFile:save', (_e, { name, dataBase64, category } = {}) => {
    try {
      const safe = String(name || 'file').replace(/[^\w.\-가-힣 ()]/g, '_');
      // 입력한 이름 그대로 저장(랜덤 접두사 없음). 이름이 겹치면 (2),(3)… 을 붙여 덮어쓰기 방지.
      const dir = calibFilesDir(category);
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      let full = path.join(dir, safe), n = 2;
      while (fs.existsSync(full)) { full = path.join(dir, `${stem} (${n})${ext}`); n++; }
      fs.writeFileSync(full, Buffer.from(dataBase64, 'base64'));
      return { ok: true, path: full, name: path.basename(full) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 첨부파일 전용 Gist에 파일 내용(base64 텍스트)을 올려 다른 PC와 공유한다.
  ipcMain.handle('calibFile:uploadAttachment', async (_e, { gistKey, dataBase64 } = {}) => {
    try {
      if (!gistKey || !dataBase64) return { ok: false, error: '잘못된 요청' };
      const cfg = loadSyncConfig();
      const token = effectiveToken(cfg);
      if (!token) return { ok: false, error: '업로드하려면 GitHub 토큰이 필요합니다' };
      const attachGistId = await ensureAttachGistId();
      await ghRequest('PATCH', `https://api.github.com/gists/${attachGistId}`, {
        token,
        body: { files: { [gistKey]: { content: dataBase64 } } },
      });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('calibFile:open', async (_e, arg) => {
    try {
      const { filePath, gistKey, fileName, category } = typeof arg === 'string' ? { filePath: arg } : (arg || {});
      const resolved = await resolveAttachmentLocalPath({ filePath, gistKey, fileName, category });
      if (!resolved.ok) return resolved;
      const r = await shell.openPath(resolved.path);
      return { ok: !r, error: r || undefined, newPath: resolved.path };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 사용점 사진처럼 앱 안에서 바로(외부 뷰어 없이) 고화질로 보여줄 때 쓴다 —
  // 로컬/캐시에 없으면 공유 Gist에서 받아 캐시에 저장한 뒤, 그 파일을 읽어
  // data URL로 돌려준다(렌더러가 file:// 접근 없이 바로 <img>에 넣을 수 있게).
  ipcMain.handle('calibFile:resolveImage', async (_e, arg) => {
    try {
      const { filePath, gistKey, fileName, category } = typeof arg === 'string' ? { filePath: arg } : (arg || {});
      const resolved = await resolveAttachmentLocalPath({ filePath, gistKey, fileName, category });
      if (!resolved.ok) return resolved;
      const b64 = fs.readFileSync(resolved.path).toString('base64');
      return { ok: true, dataUrl: `data:${guessImageMime(fileName || resolved.path)};base64,${b64}`, path: resolved.path };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('calibFile:reveal', (_e, arg) => {
    try {
      const { filePath, gistKey, fileName, category } = typeof arg === 'string' ? { filePath: arg } : (arg || {});
      let target = filePath;
      if ((!target || !fs.existsSync(target)) && gistKey) {
        const cachePath = attachCachePath(category, gistKey, fileName);
        if (fs.existsSync(cachePath)) target = cachePath;
      }
      if (!target || !fs.existsSync(target)) return { ok: false, error: '파일을 찾을 수 없습니다 (먼저 "열기"로 내려받으세요)' };
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 첨부파일 공유 기능이 생기기 전에 로컬에만 저장돼 있던 기존 첨부파일들을
  // 한 번에 첨부파일 전용 Gist로 올려 다른 PC와 공유되게 하는 일회성 이관 기능.
  // 이미 gistKey가 있는(공유된) 항목은 건너뛰고, 로컬 파일이 실제로 존재하는
  // 항목만 올린다. 요청 수를 줄이려고 여러 파일을 한 PATCH에 묶어서 보낸다.
  ipcMain.handle('calibFile:backfillAttachments', async (event) => {
    // 렌더러에 진행 상황을 실시간으로 알려준다 — 전체 과정이 IPC 호출 하나로
    // 끝나면 완료될 때까지 화면에 아무 반응이 없어 보이는 문제를 막기 위함.
    const sendProgress = (phase, extra = {}) => {
      try { event.sender.send('calibFile:backfillProgress', { phase, ...extra }); } catch { /* 창이 닫혔으면 무시 */ }
    };
    try {
      sendProgress('checking');
      const cfg = loadSyncConfig();
      const token = effectiveToken(cfg);
      if (!token) return { ok: false, error: '업로드하려면 GitHub 토큰이 필요합니다' };
      const data = loadData();
      const attachGistId = await ensureAttachGistId();
      // 이미 gistKey가 있어도 실제로 그 파일이 지금의 attachGistId 안에 있는지
      // 확인한다 — 예전 동시 업로드 버그로 다른(고아가 된) Gist를 가리키는 항목이
      // 있으면 "파일을 찾을 수 없습니다" 오류로 이어지므로, 그런 것도 다시 올려
      // 고친다. 목록 조회는 한 번만 한다(항목마다 조회하면 API 요청이 너무 많아짐).
      let existingKeys = new Set();
      try {
        const g = await ghRequest('GET', `https://api.github.com/gists/${attachGistId}`, { token });
        existingKeys = new Set(Object.keys(g.json.files || {}));
      } catch { /* 조회 실패 시 안전하게 "전부 없다"고 보고 다시 올림 */ }
      const pending = [];
      (data.calibration || []).forEach((item, itemIdx) => {
        (item.history || []).forEach((h, histIdx) => {
          if (!h.filePath || !fs.existsSync(h.filePath)) return;
          const dot = h.filePath.lastIndexOf('.');
          const ext = dot > 0 ? h.filePath.slice(dot) : '';
          const gistKey = h.gistKey || `attach_${h.id}${ext}.b64`;
          if (!existingKeys.has(gistKey)) {
            pending.push({ kind: 'calib', itemIdx, histIdx, filePath: h.filePath, gistKey });
          }
        });
      });
      // 사용점 관리 사진도 함께 올린다. 토큰이 없거나 만료된 상태에서 사진을
      // 등록하면 공유 Gist에 못 올라가 photoGistKey가 비게 되고, 그러면 다른 PC는
      // 작게 압축된 미리보기만 볼 수 있다("다른 사람이 올린 사진이 고화질로
      // 안 열린다"의 원인). 여기서 뒤늦게 올려 모든 PC가 원본을 볼 수 있게 한다.
      (data.usagePoints || []).forEach((u, itemIdx) => {
        if (!u.photoFilePath || !fs.existsSync(u.photoFilePath)) return;
        const gistKey = u.photoGistKey || `attach_up_${u.id}.jpg.b64`;
        if (!existingKeys.has(gistKey)) {
          pending.push({ kind: 'usagepoint', itemIdx, filePath: u.photoFilePath, gistKey });
        }
      });
      if (!pending.length) return { ok: true, uploaded: 0, total: 0, failed: [] };
      sendProgress('uploading', { done: 0, total: pending.length });
      const BATCH = 10;
      let uploaded = 0;
      const failed = [];
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const files = {};
        for (const p of batch) {
          try { files[p.gistKey] = { content: fs.readFileSync(p.filePath).toString('base64') }; }
          catch (e) { failed.push({ filePath: p.filePath, error: e.message }); }
        }
        if (Object.keys(files).length) {
          try {
            await ghRequest('PATCH', `https://api.github.com/gists/${attachGistId}`, { token, body: { files } });
            batch.forEach(p => {
              if (!files[p.gistKey]) return;
              if (p.kind === 'usagepoint') data.usagePoints[p.itemIdx].photoGistKey = p.gistKey;
              else data.calibration[p.itemIdx].history[p.histIdx].gistKey = p.gistKey;
              uploaded++;
            });
          } catch (e) {
            batch.forEach(p => { if (files[p.gistKey]) failed.push({ filePath: p.filePath, error: e.message }); });
          }
        }
        sendProgress('uploading', { done: Math.min(i + BATCH, pending.length), total: pending.length });
      }
      saveData(data);
      if (uploaded > 0) {
        sendProgress('finalizing', { done: pending.length, total: pending.length });
        try { await syncUpload(); } catch { /* 메타데이터 반영 실패해도 파일 업로드 자체는 성공 */ }
      }
      return { ok: true, uploaded, total: pending.length, failed };
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

  // 완료되지 않은 할일 알람 리마인드 주기 (이 PC 전용 설정, 0 = 꺼짐)
  ipcMain.handle('todoReminder:get', () => ({ intervalMin: getReminderIntervalMin() }));
  ipcMain.handle('todoReminder:set', (_e, intervalMin) => {
    const p = loadPrefs();
    p.reminderIntervalMin = Math.max(0, parseInt(intervalMin) || 0);
    savePrefs(p);
    return { ok: true, intervalMin: p.reminderIntervalMin };
  });

  // ── 관리자 권한 — 로그인 계정의 isAdmin 여부로 결정된다(아래 members:* 참고) ──
  ipcMain.handle('admin:isUnlocked', () => computeAdminUnlocked());

  // ── 사용자 계정(멤버) — 로그인 계정별로 보이는 탭 메뉴가 다르다. isAdmin이 있는
  // 계정으로 로그인하면 그 자체로 관리자 권한(편집 권한)도 함께 열린다 — 로그인과
  // 관리자 권한이 하나로 합쳐진 것이다. 로그인은 필수가 아니며, 로그인하지 않으면
  // "권한 설정"에서 정한 게스트 메뉴(guestAllowedTabs)가 보인다.
  ipcMain.handle('members:getAll', () => {
    const data = loadData();
    return (data.memberAccounts || []).map(m => ({ id: m.id, username: m.username, allowedTabs: m.allowedTabs || [], hasToken: !!m.token, isAdmin: !!m.isAdmin }));
  });
  ipcMain.handle('members:upsert', (_e, member = {}) => {
    const data = loadData();
    if (!data.memberAccounts) data.memberAccounts = [];
    if (member.id) {
      // 편집(id 지정) 시 username/allowedTabs가 함께 오지 않으면(예: 토큰만 삭제하는
      // 호출) 기존 값을 그대로 유지한다 — 안 그러면 "사용자이름을 입력하세요"로 실패한다.
      const idx = data.memberAccounts.findIndex(m => m.id === member.id);
      if (idx < 0) return { ok: false, error: '존재하지 않는 사용자입니다' };
      const username = member.username !== undefined ? String(member.username).trim() : data.memberAccounts[idx].username;
      if (!username) return { ok: false, error: '사용자이름을 입력하세요' };
      const allowedTabs = Array.isArray(member.allowedTabs) ? member.allowedTabs : data.memberAccounts[idx].allowedTabs;
      if (data.memberAccounts.some(m => m.id !== member.id && m.username === username)) {
        return { ok: false, error: '이미 사용 중인 사용자이름입니다' };
      }
      const wasAdmin = !!data.memberAccounts[idx].isAdmin;
      const willBeAdmin = member.isAdmin !== undefined ? !!member.isAdmin : wasAdmin;
      if (wasAdmin && !willBeAdmin && !data.memberAccounts.some((m, i) => i !== idx && m.isAdmin)) {
        return { ok: false, error: '마지막 관리자 계정입니다. 다른 계정에 먼저 관리자 권한을 부여하세요.' };
      }
      data.memberAccounts[idx].username = username;
      data.memberAccounts[idx].allowedTabs = allowedTabs;
      data.memberAccounts[idx].isAdmin = willBeAdmin;
      if (member.password) data.memberAccounts[idx].passwordHash = hashPassword(member.password);
      // 토큰: clearToken이면 삭제, token이 오면(빈 값 아니면) 교체, 안 오면 기존 값 유지.
      if (member.clearToken) delete data.memberAccounts[idx].token;
      else if (member.token) data.memberAccounts[idx].token = obfuscateToken(String(member.token).trim());
      saveData(data);
      broadcastAdminUnlocked();
      return { ok: true, id: member.id };
    }
    const username = String(member.username || '').trim();
    if (!username) return { ok: false, error: '사용자이름을 입력하세요' };
    const allowedTabs = Array.isArray(member.allowedTabs) ? member.allowedTabs : [];
    if (data.memberAccounts.some(m => m.username === username)) {
      return { ok: false, error: '이미 사용 중인 사용자이름입니다' };
    }
    if (!member.password) return { ok: false, error: '비밀번호를 입력하세요' };
    const id = newId();
    const newMember = { id, username, passwordHash: hashPassword(member.password), allowedTabs, isAdmin: !!member.isAdmin };
    if (member.token) newMember.token = obfuscateToken(String(member.token).trim());
    data.memberAccounts.push(newMember);
    saveData(data);
    return { ok: true, id };
  });
  ipcMain.handle('members:delete', (_e, id) => {
    const data = loadData();
    const target = (data.memberAccounts || []).find(m => m.id === id);
    if (target?.isAdmin && !data.memberAccounts.some(m => m.id !== id && m.isAdmin)) {
      return { ok: false, error: '마지막 관리자 계정은 삭제할 수 없습니다.' };
    }
    data.memberAccounts = (data.memberAccounts || []).filter(m => m.id !== id);
    saveData(data);
    return { ok: true };
  });
  ipcMain.handle('members:login', (_e, { username, password } = {}) => {
    const data = loadData();
    const m = (data.memberAccounts || []).find(m => m.username === String(username || '').trim());
    if (!m || hashPassword(password) !== m.passwordHash) return { ok: false, error: '사용자이름 또는 비밀번호가 올바르지 않습니다' };
    return { ok: true, member: { id: m.id, username: m.username, allowedTabs: m.allowedTabs || [], isAdmin: !!m.isAdmin } };
  });
  // 로그인한 본인이 관리자 도움 없이 직접 비밀번호를 바꾼다(현재 비밀번호 확인 필요).
  // 관리자가 MemberManager에서 바꿔주는 것(members:upsert)과는 별개 경로.
  ipcMain.handle('members:changePassword', (_e, { id, oldPassword, newPassword } = {}) => {
    const data = loadData();
    const idx = (data.memberAccounts || []).findIndex(m => m.id === id);
    if (idx < 0) return { ok: false, error: '존재하지 않는 계정입니다' };
    if (hashPassword(oldPassword) !== data.memberAccounts[idx].passwordHash) {
      return { ok: false, error: '현재 비밀번호가 올바르지 않습니다' };
    }
    if (!newPassword) return { ok: false, error: '새 비밀번호를 입력하세요' };
    data.memberAccounts[idx].passwordHash = hashPassword(newPassword);
    saveData(data);
    return { ok: true };
  });
  // 렌더러가 로그인 상태를 알려주면(로그인·로그아웃·앱 시작 시 재수화 포함) 이 PC의
  // 공유 업로드에 그 계정 전용 토큰(있다면)을 자동으로 쓴다.
  ipcMain.handle('members:setCurrent', (_e, memberId) => {
    currentMemberId = memberId || null;
    broadcastAdminUnlocked();
    return { ok: true };
  });

  // 로그인하지 않았을 때 보이는 메뉴 — null이면 제한 없음(전체 메뉴), 배열이면 그 탭들만.
  ipcMain.handle('guestAccess:get', () => {
    const data = loadData();
    return { allowedTabs: data.guestAllowedTabs || null };
  });
  ipcMain.handle('guestAccess:set', (_e, allowedTabs) => {
    const data = loadData();
    data.guestAllowedTabs = Array.isArray(allowedTabs) ? allowedTabs : null;
    saveData(data);
    return { ok: true };
  });

  // ── 주간근무 (업무 로테이션 담당표) ──
  ipcMain.handle('weeklyDuty:get', () => {
    return loadData().weeklyDuty;
  });
  ipcMain.handle('weeklyDuty:set', (_e, weeklyDuty) => {
    const data = loadData();
    data.weeklyDuty = weeklyDuty;
    saveData(data);
    try { syncWeeklyDutyTodos(); } catch { /* ignore */ } // 저장 직후 이 PC의 오늘 할일도 바로 반영
    return { ok: true };
  });
  // 오늘 담당자 할일을 지금 바로 다시 계산해 반영한다(설정을 막 바꿨을 때 확인용).
  ipcMain.handle('weeklyDuty:syncTodosNow', () => {
    try { syncWeeklyDutyTodos(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 할일(반복 일정) — 설치본 공유 데이터가 아닌 이 PC 로컬 파일에서 관리 ──
  ipcMain.handle('todos:getAll', () => loadTodos());
  ipcMain.handle('todos:upsert', (_e, todo) => {
    const todos = loadTodos();
    if (todo.id) {
      const i = todos.findIndex(t => t.id === todo.id);
      if (i >= 0) todos[i] = todo; else todos.push(todo);
      // 알람 시간을 수정했으면 발사 기록을 지워 새 시간에 다시 울리게 한다
      for (const k of [...firedAlarms.keys()]) { if (k.startsWith(todo.id + '_')) firedAlarms.delete(k); }
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

  // ── 사용점 관리 ──
  ipcMain.handle('usagePoints:getAll', () => {
    return loadData().usagePoints;
  });

  ipcMain.handle('usagePoints:upsert', (_e, item) => {
    const data = loadData();
    // 여러 PC가 같은 항목을 고쳤을 때 어느 쪽이 최신인지 판단하는 기준 (합치기용)
    item.updatedAt = new Date().toISOString();
    if (item.id) {
      const idx = data.usagePoints.findIndex(u => u.id === item.id);
      if (idx >= 0) data.usagePoints[idx] = item;
      else data.usagePoints.push(item);
    } else {
      item.id = newId();
      data.usagePoints.push(item);
    }
    saveData(data);
    return item;
  });

  ipcMain.handle('usagePoints:delete', (_e, id) => {
    const data = loadData();
    data.usagePoints = data.usagePoints.filter(u => u.id !== id);
    saveData(data);
  });

  // 대분류(공조/가스/용수/기타)별 소분류 목록 — 관리자가 추가·수정한다.
  ipcMain.handle('usagePointCategories:get', () => {
    return loadData().usagePointCategories;
  });

  ipcMain.handle('usagePointCategories:set', (_e, categories) => {
    const data = loadData();
    data.usagePointCategories = categories;
    saveData(data);
    return data.usagePointCategories;
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

  // ── 연간계획(AHU) 목록 — 사용자가 추가한 AHU를 공유 데이터에 저장해 재시작/다른 PC에서도 유지 ──
  ipcMain.handle('annualPlanAhus:getAll', () => loadData().annualPlanAhus);

  ipcMain.handle('annualPlanAhus:add', (_e, name) => {
    const data = loadData();
    const trimmed = String(name || '').trim();
    if (trimmed && !data.annualPlanAhus.includes(trimmed)) {
      data.annualPlanAhus.push(trimmed);
      saveData(data);
    }
    return data.annualPlanAhus;
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

  // ── 일정 담당자 배정 ──
  // 측정 완료와 같은 키(zoneId_num = "그 구역의 몇 번째 측정")로 담당자를 저장한다.
  // 값이 비면 배정 해제로 보고 항목 자체를 지운다(빈 문자열이 쌓이지 않게).
  ipcMain.handle('scheduleAssignees:getAll', () => loadData().scheduleAssignees || {});
  ipcMain.handle('scheduleAssignees:set', (_e, zoneId, num, assignee) => {
    const data = loadData();
    if (!data.scheduleAssignees) data.scheduleAssignees = {};
    const key = `${zoneId}_${num}`;
    const name = String(assignee || '').trim();
    if (name) data.scheduleAssignees[key] = name;
    else delete data.scheduleAssignees[key];
    saveData(data);
    return { ok: true };
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
