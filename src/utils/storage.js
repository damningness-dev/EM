import { INITIAL_CALIBRATION, MONITORING_ZONES, AHU_LIST } from '../data/initialData';

const KEYS = {
  CALIBRATION: 'em_calibration',
  MONITORING_ZONES: 'em_monitoring_zones',
  MONITORING_DATA: 'em_monitoring_data',
  ANNUAL_PLAN: 'em_annual_plan',
  YEAR: 'em_year',
};

export function getYear() {
  return parseInt(localStorage.getItem(KEYS.YEAR) || '2026');
}
export function setYear(year) {
  localStorage.setItem(KEYS.YEAR, String(year));
}

// 교정 데이터
export function getCalibration() {
  const raw = localStorage.getItem(KEYS.CALIBRATION);
  return raw ? JSON.parse(raw) : INITIAL_CALIBRATION;
}
export function saveCalibration(data) {
  localStorage.setItem(KEYS.CALIBRATION, JSON.stringify(data));
}

// 모니터링 구역
export function getMonitoringZones() {
  const raw = localStorage.getItem(KEYS.MONITORING_ZONES);
  return raw ? JSON.parse(raw) : MONITORING_ZONES;
}
export function saveMonitoringZones(data) {
  localStorage.setItem(KEYS.MONITORING_ZONES, JSON.stringify(data));
}

// 모니터링 측정 데이터: { year_month_zoneId: { airborne, settle, surface, particle, count, note, startDate, done } }
export function getMonitoringData() {
  const raw = localStorage.getItem(KEYS.MONITORING_DATA);
  return raw ? JSON.parse(raw) : {};
}
export function saveMonitoringData(data) {
  localStorage.setItem(KEYS.MONITORING_DATA, JSON.stringify(data));
}
export function getMonitoringKey(year, month, zoneId) {
  return `${year}_${month}_${zoneId}`;
}

// 연간계획: { year_ahuId_month: { planned, done, note } }
export function getAnnualPlan() {
  const raw = localStorage.getItem(KEYS.ANNUAL_PLAN);
  return raw ? JSON.parse(raw) : {};
}
export function saveAnnualPlan(data) {
  localStorage.setItem(KEYS.ANNUAL_PLAN, JSON.stringify(data));
}
export function getAnnualPlanKey(year, ahuId, month) {
  return `${year}_${ahuId}_${month}`;
}
