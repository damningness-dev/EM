const api = window.electronAPI;

// ─── 교정 ─────────────────────────────────────────────────────────────────────

export async function fetchCalibration() {
  return api.invoke('calibration:getAll');
}

export async function upsertCalibration(item) {
  return api.invoke('calibration:upsert', item);
}

export async function deleteCalibration(id) {
  return api.invoke('calibration:delete', id);
}

// 교정 첨부파일 — 로컬 저장 + (동기화 설정이 있으면) 첨부파일 전용 Gist에도 올려
// 다른 PC와 공유한다. 다른 PC는 "열기"를 누르는 순간에만 그 파일 하나를 내려받는다.
export async function saveCalibFile(name, dataBase64) {
  return api.invoke('calibFile:save', { name, dataBase64 });
}
export async function uploadCalibAttachment(gistKey, dataBase64) {
  return api.invoke('calibFile:uploadAttachment', { gistKey, dataBase64 });
}
export async function openCalibFile(filePath, gistKey) {
  return api.invoke('calibFile:open', { filePath, gistKey });
}
export async function revealCalibFile(filePath, gistKey) {
  return api.invoke('calibFile:reveal', { filePath, gistKey });
}
// 첨부파일 공유 기능이 생기기 전에 로컬에만 있던 기존 첨부파일들을 한 번에
// 첨부파일 전용 Gist로 올려 다른 PC와 공유되게 하는 일회성 이관 기능.
export async function backfillCalibAttachments() {
  return api.invoke('calibFile:backfillAttachments');
}

// ─── 구역 ─────────────────────────────────────────────────────────────────────

export async function fetchZones() {
  return api.invoke('zones:getAll');
}

export async function upsertZone(zone) {
  return api.invoke('zones:upsert', zone);
}

export async function deleteZone(id) {
  return api.invoke('zones:delete', id);
}

// 월별 모니터링에 입력해 둔 측정포인트(부유균/낙하균/표면균/부유입자)를
// 구역의 points_* 필드로 backfill — points가 비어있는 구역만 채우고 영구 저장.
//   airborne=부유균→points_float, settle=낙하균→points_fall,
//   surface=표면균→points_surface, particle=부유입자→points_particle
export async function backfillZonePointsFromMonitoring(zones, years) {
  const num = v => { const n = parseInt(v); return Number.isFinite(n) ? n : 0; };
  const latest = {}; // zoneId → 가장 최근(병합된) 모니터링 엔트리
  for (const y of years) {
    let yearData;
    try { yearData = await fetchAllMonitoringData(y); } catch { continue; }
    Object.entries(yearData || {}).forEach(([key, val]) => {
      const zoneId = key.slice(0, key.lastIndexOf('_'));
      latest[zoneId] = { ...(latest[zoneId] || {}), ...val };
    });
  }
  const updated = [];
  const result = zones.map(z => {
    const hasPoints = z.points_float || z.points_fall || z.points_surface || z.points_particle;
    if (hasPoints) return z;
    const e = latest[z.id];
    if (!e) return z;
    const pf = num(e.airborne), pl = num(e.settle), ps = num(e.surface), pp = num(e.particle);
    if (!pf && !pl && !ps && !pp) return z;
    const nz = { ...z, points_float: pf, points_fall: pl, points_surface: ps, points_particle: pp };
    updated.push(nz);
    return nz;
  });
  for (const u of updated) { try { await upsertZone(u); } catch {} }
  return { zones: result, changed: updated.length };
}

// ─── 월별 모니터링 ────────────────────────────────────────────────────────────

export async function fetchMonitoringData(year, month) {
  return api.invoke('monitoring:getMonth', year, month);
}

export async function fetchAllMonitoringData(year) {
  return api.invoke('monitoring:getYear', year);
}

export async function upsertMonitoringEntry(entry) {
  return api.invoke('monitoring:upsert', entry);
}

// ─── 연간 계획 ────────────────────────────────────────────────────────────────

export async function fetchAnnualPlan(year) {
  return api.invoke('annualPlan:getYear', year);
}

export async function upsertAnnualPlan(entry) {
  return api.invoke('annualPlan:upsert', entry);
}

// 연간계획(AHU) 목록 — 사용자가 화면에서 추가한 AHU도 공유 데이터에 저장되어 유지된다.
export async function fetchAnnualPlanAhus() {
  return api.invoke('annualPlanAhus:getAll');
}
export async function addAnnualPlanAhu(name) {
  return api.invoke('annualPlanAhus:add', name);
}

// ─── 초기 데이터 시딩 ─────────────────────────────────────────────────────────

export async function seedInitialData(calibrationData, zonesData) {
  return api.invoke('data:seed', calibrationData, zonesData);
}

// ─── 측정주기 설정 ────────────────────────────────────────────────────────────

export async function fetchScheduleConfig() {
  return api.invoke('scheduleConfig:get');
}

export async function saveScheduleConfig(config) {
  return api.invoke('scheduleConfig:set', config);
}

// ─── 그룹 ─────────────────────────────────────────────────────────────────────

export async function fetchGroups() {
  return api.invoke('groups:getAll');
}

export async function upsertGroup(group) {
  return api.invoke('groups:upsert', group);
}

export async function deleteGroup(id) {
  return api.invoke('groups:delete', id);
}

// ─── 공휴일 ───────────────────────────────────────────────────────────────────

export async function fetchHolidays() {
  return api.invoke('holidays:getAll');
}

export async function upsertHoliday(holiday) {
  return api.invoke('holidays:upsert', holiday);
}

export async function deleteHoliday(date) {
  return api.invoke('holidays:delete', date);
}

// ─── 측정 완료 ────────────────────────────────────────────────────────────────

export async function fetchCompletions() {
  return api.invoke('completions:getAll');
}

export async function setCompletion(zoneId, num) {
  return api.invoke('completions:set', zoneId, num);
}

export async function deleteCompletion(zoneId, num) {
  return api.invoke('completions:delete', zoneId, num);
}

// ─── 일정 비우기(차단 날짜) ────────────────────────────────────────────────────

export async function fetchBlockedDates() {
  return api.invoke('blockedDates:getAll');
}

export async function setBlockedDate(date, blocked) {
  return api.invoke('blockedDates:set', date, blocked);
}

// ─── 할일(반복 일정) ──────────────────────────────────────────────────────────

export async function fetchTodos() {
  return api.invoke('todos:getAll');
}
export async function upsertTodo(todo) {
  return api.invoke('todos:upsert', todo);
}
export async function deleteTodo(id) {
  return api.invoke('todos:delete', id);
}
export async function toggleTodoDone(id, dateStr) {
  return api.invoke('todos:toggleDone', id, dateStr);
}

// ─── 부팅 시 자동 시작 ────────────────────────────────────────────────────────

export async function getAutoStart() {
  return api.invoke('app:getAutoStart');
}
export async function setAutoStart(enabled) {
  return api.invoke('app:setAutoStart', enabled);
}

// ─── 관리자 잠금 (일정 편집 권한) ──────────────────────────────────────────────

export async function adminHasPassword() {
  return api.invoke('admin:hasPassword');
}
export async function adminIsUnlocked() {
  return api.invoke('admin:isUnlocked');
}
export async function adminSetPassword(password) {
  return api.invoke('admin:setPassword', password);
}
export async function adminUnlock(password) {
  return api.invoke('admin:unlock', password);
}
export async function adminLock() {
  return api.invoke('admin:lock');
}
export async function adminChangePassword(oldPassword, newPassword) {
  return api.invoke('admin:changePassword', { oldPassword, newPassword });
}

// ─── 사용자 계정(멤버) — 로그인 시 허용된 탭 메뉴만 표시 ───────────────────────────

export async function fetchMembers() {
  return api.invoke('members:getAll');
}
export async function upsertMember(member) {
  return api.invoke('members:upsert', member);
}
export async function deleteMember(id) {
  return api.invoke('members:delete', id);
}
export async function memberLogin(username, password) {
  return api.invoke('members:login', { username, password });
}

// ─── 공유 동기화 (Gist) ───────────────────────────────────────────────────────

export async function syncGetConfig() {
  return api.invoke('sync:getConfig');
}
export async function syncSetConfig(patch) {
  return api.invoke('sync:setConfig', patch);
}
export async function syncUpload() {
  return api.invoke('sync:upload');
}
export async function syncPull() {
  return api.invoke('sync:pull');
}

// ─── 임시 일정 ────────────────────────────────────────────────────────────────

export async function fetchTempSchedules() {
  return api.invoke('tempSchedules:getAll');
}

export async function addTempSchedule(entry) {
  return api.invoke('tempSchedules:add', entry);
}

export async function deleteTempSchedule(id) {
  return api.invoke('tempSchedules:delete', id);
}

export async function updateTempSchedule(entry) {
  return api.invoke('tempSchedules:update', entry);
}

// ─── 내보내기 (엑셀/CSV 저장 대화상자) ──────────────────────────────────────────

export async function exportScheduleExcelTable({ defaultName, sheetName, tableStyle, columns, rows }) {
  return api.invoke('export:scheduleExcelTable', { defaultName, sheetName, tableStyle, columns, rows });
}

// ─── 인쇄 (Electron 가로 방향·배경색 강제) ──────────────────────────────────────

export async function printDoc(options = {}) {
  return api.invoke('print:doc', options);
}
