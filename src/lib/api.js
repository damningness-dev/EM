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
