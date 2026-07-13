import { addDays, addMonths, addYears, startOfWeek, endOfWeek, startOfMonth, endOfMonth, format } from 'date-fns';
import { lunarToSolar } from './lunar';

// Grade progression order: P1 → P2 → P3 → 유지관리
export const NEXT_GRADE = { P1: 'P2', P2: 'P3', P3: '유지관리' };

// Higher = more frequent (used to determine group master zone)
export const GRADE_PRIORITY = { P1: 4, P2: 3, P3: 2, '유지관리': 1 };

export const NTH_LABEL = ['', '1', '2', '3', '4', '마지막'];
export const DOW_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

function getNthWeekdayOfMonth(year, month, nth, dow) {
  // nth: 1-4 or 5 (last), dow: 0=Sun...6=Sat
  const firstDow = new Date(year, month - 1, 1).getDay();
  let day = 1 + ((dow - firstDow + 7) % 7);
  const daysInMonth = new Date(year, month, 0).getDate();
  if (nth === 5) {
    while (day + 7 <= daysInMonth) day += 7;
  } else {
    day += (nth - 1) * 7;
    if (day > daysInMonth) day -= 7;
  }
  return new Date(year, month - 1, day);
}

// 월 기반 측정의 이동 가능 창. 분기(3)·반기(6)·년(12)은 달력 경계에 맞춘다.
//  - 분기: 1~3, 4~6, 7~9, 10~12월 / 반기: 1~6, 7~12월 / 년: 1~12월
//  - 그 외(월 간격 N)는 시작월부터 롤링 span개월
function monthSpanWindow(baseDate, spanMonths) {
  const span = Math.max(1, spanMonths || 1);
  const y = baseDate.getFullYear(), m = baseDate.getMonth();
  let start;
  if (span === 3) start = Math.floor(m / 3) * 3;
  else if (span === 6) start = m < 6 ? 0 : 6;
  else if (span === 12) start = 0;
  else return { min: startOfMonth(baseDate), max: endOfMonth(addMonths(baseDate, span - 1)) };
  return { min: new Date(y, start, 1), max: endOfMonth(new Date(y, start + span - 1, 1)) };
}

function isOverrideValid(overrideDate, baseDate, type, spanMonths = 1) {
  if (type === 'daily' || type === 'weekly' || type === 'biweekly') {
    const min = startOfWeek(baseDate, { weekStartsOn: 1 });
    const max = endOfWeek(baseDate, { weekStartsOn: 1 });
    return overrideDate >= min && overrideDate <= max;
  }
  if (type === 'monthly' || type === 'quarterly') {
    const { min, max } = monthSpanWindow(baseDate, spanMonths);
    return overrideDate >= min && overrideDate <= max;
  }
  return false;
}

// 카테고리·등급별 기본 측정주기 (사용자가 설정에서 변경 가능)
// phase: { durationValue, durationUnit: 'day'|'week'|'month'|'year', unit: 'day'|'week'|'month', interval, count(자동계산) }
//   "durationValue durationUnit 동안 interval unit 간격으로" → count회 자동 산출
export const DEFAULT_SCHEDULE_SPECS = {
  '공조': {
    'P1':     [{ durationValue: 7,  durationUnit: 'day',   unit: 'day',   interval: 1, count: 7 }],
    'P2':     [{ durationValue: 4,  durationUnit: 'week',  unit: 'week',  interval: 1, count: 4 },
               { durationValue: 12, durationUnit: 'week',  unit: 'week',  interval: 2, count: 6 }],
    'P3':     [{ durationValue: 12, durationUnit: 'month', unit: 'month', interval: 1, count: 12 }],
    '유지관리': [{ durationValue: 36, durationUnit: 'month', unit: 'month', interval: 1, count: 36 }],
  },
  '압축공기': {
    'P1':     [{ durationValue: 7,  durationUnit: 'day',   unit: 'day',   interval: 1, count: 7 }],
    'P2':     [{ durationValue: 26, durationUnit: 'week',  unit: 'week',  interval: 2, count: 13 }],
    'P3':     [{ durationValue: 12, durationUnit: 'month', unit: 'month', interval: 1, count: 12 }],
    '유지관리': [{ durationValue: 36, durationUnit: 'month', unit: 'month', interval: 3, count: 12 }],
  },
  '질소가스': {
    'P1':     [{ durationValue: 7,  durationUnit: 'day',   unit: 'day',   interval: 1, count: 7 }],
    'P2':     [{ durationValue: 26, durationUnit: 'week',  unit: 'week',  interval: 2, count: 13 }],
    'P3':     [{ durationValue: 12, durationUnit: 'month', unit: 'month', interval: 1, count: 12 }],
    '유지관리': [{ durationValue: 36, durationUnit: 'month', unit: 'month', interval: 3, count: 12 }],
  },
  '용수': {
    'P1':     [{ durationValue: 7,  durationUnit: 'day',   unit: 'day',   interval: 1, count: 7 }],
    'P2':     [{ durationValue: 26, durationUnit: 'week',  unit: 'week',  interval: 2, count: 13 }],
    'P3':     [{ durationValue: 12, durationUnit: 'month', unit: 'month', interval: 1, count: 12 }],
    '유지관리': [{ durationValue: 36, durationUnit: 'month', unit: 'month', interval: 3, count: 12 }],
  },
};

// 대분류(고정 4종). 사용자가 추가하는 소분류는 __major로 소속 대분류를 가리킨다.
export const MAJOR_CATS = ['공조', '압축공기', '질소가스', '용수'];

// 분류의 대분류를 반환 (대분류면 자신, 소분류면 __major, 없으면 자신)
export function getMajorCat(cat, cfg) {
  if (MAJOR_CATS.includes(cat)) return cat;
  const c = (cfg || getScheduleConfig())[cat];
  return (c && c.__major) || cat;
}

// 측정주기 단위 → 일수 환산(횟수 자동 계산용; 월/분기/반기/년은 평균값)
export const UNIT_DAYS = { day: 1, week: 7, month: 365.25 / 12, quarter: 365.25 / 4, half: 365.25 / 2, year: 365.25 };

// 월 기반 간격 단위 → 개월 수 (분기=3, 반기=6, 년=12)
export const MONTHS_PER_UNIT = { month: 1, quarter: 3, half: 6, year: 12 };

// 기간/간격으로부터 측정 횟수 자동 계산
export function computePhaseCount(durationValue, durationUnit, interval, unit) {
  const durDays = (Number(durationValue) || 0) * (UNIT_DAYS[durationUnit] || 1);
  const intDays = (Number(interval) || 1) * (UNIT_DAYS[unit] || 1);
  if (intDays <= 0) return 1;
  return Math.max(1, Math.round(durDays / intDays));
}

// 구형/신형 phase 데이터를 계산용 { count, unit, interval }로 정규화
function normalizePhase(p) {
  // 1) unit/interval 결정
  let unit, interval;
  if (p.unit) {
    unit = p.unit;
    interval = p.interval ?? 1;
  } else {
    switch (p.type) {
      case 'daily':     unit = 'day';   interval = 1; break;
      case 'weekly':    unit = 'week';  interval = 1; break;
      case 'biweekly':  unit = 'week';  interval = 2; break;
      case 'monthly':   unit = 'month'; interval = 1; break;
      case 'quarterly': unit = 'month'; interval = 3; break;
      default:
        if (p.intervalDays && p.intervalDays % 7 === 0) { unit = 'week'; interval = p.intervalDays / 7; }
        else { unit = 'day'; interval = p.intervalDays ?? 1; }
    }
  }
  // 2) count: 기간 정보가 있으면 자동 계산, 없으면 저장된 count
  const count = (p.durationValue != null && p.durationUnit)
    ? computePhaseCount(p.durationValue, p.durationUnit, interval, unit)
    : (p.count || 1);
  return { count, unit, interval };
}

// unit → getDragBounds/isOverrideValid에 전달할 legacy type 문자열
function unitToType(unit) {
  if (MONTHS_PER_UNIT[unit]) return 'monthly'; // month/quarter/half/year → 월 단위 취급
  if (unit === 'week')  return 'weekly';
  return 'daily';
}

// 모듈 레벨 설정 저장소 — 앱 시작 시 setScheduleConfig로 주입
let SCHEDULE_CONFIG = null;

export function setScheduleConfig(cfg) {
  SCHEDULE_CONFIG = cfg && typeof cfg === 'object' ? cfg : null;
}

export function getScheduleConfig() {
  return SCHEDULE_CONFIG || DEFAULT_SCHEDULE_SPECS;
}

export function getScheduleSpec(category, grade) {
  const cfg = getScheduleConfig();
  const catCfg = cfg[category] || DEFAULT_SCHEDULE_SPECS[category];
  if (!catCfg) return null;
  const spec = catCfg[grade] || DEFAULT_SCHEDULE_SPECS[category]?.[grade];
  if (!spec || !spec.length) return null;
  return spec;
}

// A working day = weekday (Mon–Fri) that is not a registered holiday.
export function isWorkingDay(date, holidayMap = {}) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  if (holidayMap[format(date, 'yyyy-MM-dd')]) return false;
  return true;
}

// If date falls on a weekend/holiday, shift to the nearest working day within
// the measurement cycle window — backward first (Sat→Fri→Thu...), then forward.
function adjustToWorkingDay(date, bounds, holidayMap) {
  if (isWorkingDay(date, holidayMap)) return date;
  let d = addDays(date, -1);
  while (d >= bounds.min) {
    if (isWorkingDay(d, holidayMap)) return d;
    d = addDays(d, -1);
  }
  d = addDays(date, 1);
  while (d <= bounds.max) {
    if (isWorkingDay(d, holidayMap)) return d;
    d = addDays(d, 1);
  }
  return date;
}

// holidayMap: 근무일 판정용 (공휴일 + 일정비우기)
// usedDates: 같은 날 중복을 막기 위해 이미 사용한 날짜('yyyy-MM-dd') Set.
//   null이면 이 구역만의 새 Set을 쓴다. 여러 구역(같은 구역명의 P1/P2/P3…)의
//   중복까지 막으려면 호출측에서 공유 Set을 넘긴다.
export function calcMeasurements(zone, holidayMap = {}, usedDates = null) {
  if (!zone.schedule_start) return [];
  const spec = getScheduleSpec(zone.category, zone.grade);
  if (!spec) return [];

  const overrides = zone.schedule_overrides || {};
  const weekdayRule = zone.monthly_weekday_rule || null;
  const measurements = [];
  // 같은 구역(또는 같은 구역명)의 측정이 같은 날에 겹치지 않도록 사용한 날짜를 추적.
  const used = usedDates || new Set();
  const normSpec = spec.map(normalizePhase);
  const total = normSpec.reduce((s, p) => s + p.count, 0);

  // 시작 회차: 입력한 시작일을 몇 번째 측정으로 볼지 (기본 1).
  // 예) 총 12회 중 start_num=5 → 시작일이 5번째 측정, 이후 5~12회차만 배치.
  const startNum = Math.max(1, Math.min(total, parseInt(zone.start_num) || 1));
  // startNum이 속한 구간(phase)과 구간 내 위치를 찾는다.
  let acc = 0, startPhaseIdx = 0, startIWithin = 0;
  for (let p = 0; p < normSpec.length; p++) {
    if (startNum <= acc + normSpec[p].count) { startPhaseIdx = p; startIWithin = startNum - acc - 1; break; }
    acc += normSpec[p].count;
  }

  let num = startNum;
  let baseDate = new Date(zone.schedule_start + 'T00:00:00');
  let lastBaseDate = null;

  for (let phaseIdx = startPhaseIdx; phaseIdx < normSpec.length; phaseIdx++) {
    const phase = normSpec[phaseIdx];
    const ptype = unitToType(phase.unit);
    // 월 기반 측정의 이동 가능 범위(개월). 분기=3, 반기=6, 년=12, 월×간격 등.
    // 이 값만큼 이동 범위가 넓어져 해당 분기/반기 내 다른 달로도 옮길 수 있다.
    const spanMonths = MONTHS_PER_UNIT[phase.unit] ? phase.interval * MONTHS_PER_UNIT[phase.unit] : 1;

    // Phase transition: advance baseDate by new phase's interval after last measurement.
    // (처음 처리하는 구간은 시작일이 곧 baseDate이므로 이동하지 않는다)
    if (phaseIdx > startPhaseIdx && lastBaseDate !== null) {
      if (MONTHS_PER_UNIT[phase.unit]) baseDate = addMonths(lastBaseDate, phase.interval * MONTHS_PER_UNIT[phase.unit]);
      else if (phase.unit === 'week') baseDate = addDays(lastBaseDate, phase.interval * 7);
      else baseDate = addDays(lastBaseDate, phase.interval);
    }

    for (let i = phaseIdx === startPhaseIdx ? startIWithin : 0; i < phase.count; i++) {
      // Apply weekday rule for month-based measurements
      let effectiveBaseDate = new Date(baseDate);
      if (MONTHS_PER_UNIT[phase.unit] && weekdayRule) {
        effectiveBaseDate = getNthWeekdayOfMonth(
          baseDate.getFullYear(), baseDate.getMonth() + 1,
          weekdayRule.nth, weekdayRule.dow
        );
      }

      const key = String(num);
      const rawOverride = overrides[key] ? new Date(overrides[key] + 'T00:00:00') : null;
      const hasValidOverride = rawOverride && isOverrideValid(rawOverride, effectiveBaseDate, ptype, spanMonths);
      let scheduledDate;
      if (hasValidOverride) {
        scheduledDate = rawOverride;
      } else {
        const bounds = getDragBounds({ type: ptype, baseDate: effectiveBaseDate, spanMonths });
        scheduledDate = adjustToWorkingDay(effectiveBaseDate, bounds, holidayMap);
        // 같은 구역(또는 같은 구역명)의 앞선 일정이 이미 이 날을 차지했다면,
        // 겹치지 않도록 다음 근무일(주말·공휴일·일정비우기 제외)로 순차적으로 밀어낸다.
        // → 첫 회차부터 자연스럽게 하루씩 뒤로 배치된다.
        while (used.has(format(scheduledDate, 'yyyy-MM-dd'))) {
          scheduledDate = addDays(scheduledDate, 1);
          while (!isWorkingDay(scheduledDate, holidayMap)) scheduledDate = addDays(scheduledDate, 1);
        }
      }
      used.add(format(scheduledDate, 'yyyy-MM-dd'));

      lastBaseDate = new Date(baseDate);
      measurements.push({
        num,
        date: scheduledDate,
        baseDate: effectiveBaseDate,
        type: ptype,
        spanMonths,
        isFirst: num === startNum,
        isLast: num === total,
      });
      num++;

      if (MONTHS_PER_UNIT[phase.unit]) {
        baseDate = addMonths(baseDate, phase.interval * MONTHS_PER_UNIT[phase.unit]);
      } else if (phase.unit === 'week') {
        baseDate = addDays(baseDate, phase.interval * 7);
      } else if (phase.unit === 'day' && phase.interval === 1) {
        // 1일 간격: 주말 건너뜀
        let next = addDays(baseDate, 1);
        while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
        baseDate = next;
      } else {
        baseDate = addDays(baseDate, phase.interval);
      }
    }
  }

  return measurements;
}

export function calcEndDate(zone) {
  const ms = calcMeasurements(zone);
  if (ms.length) return ms[ms.length - 1].baseDate;
  if (zone.grade === '유지관리' && zone.schedule_start) {
    return addYears(new Date(zone.schedule_start + 'T00:00:00'), 3);
  }
  return null;
}

export function totalCount(zone) {
  const spec = getScheduleSpec(zone.category, zone.grade);
  if (!spec) return 0;
  return spec.reduce((sum, p) => sum + p.count, 0);
}

export function getDragBounds(measurement) {
  const { type, baseDate, spanMonths } = measurement;

  if (type === 'daily' || type === 'weekly' || type === 'biweekly') {
    return {
      min: startOfWeek(baseDate, { weekStartsOn: 1 }),
      max: endOfWeek(baseDate, { weekStartsOn: 1 }),
    };
  }
  if (type === 'monthly' || type === 'quarterly') {
    // 월은 해당 월, 분기/반기/년은 달력 경계에 맞춘 창 (그 밖으로 이동 시 오류)
    return monthSpanWindow(baseDate, spanMonths);
  }
  return { min: baseDate, max: baseDate };
}

// 일정그룹 정렬: 측정주기가 짧은(잦은) 구역을 기준으로, 주기가 긴 구역의
// 측정일을 겹치는 날짜로 스냅한다. 각 구역은 자기 측정주기 창을 벗어나지 않는다.
// 예) 그룹에 P1·P2 → P2를 P1 측정일에 맞춤 / P2·P3 → P3를 P2 측정일에 맞춤
// 반환: [{ zoneId, schedule_overrides }] (변경된 구역만)
export function alignGroupSchedules(groupZones, holidayMap = {}) {
  const ordered = groupZones
    .filter(z => z.schedule_start)
    .slice()
    .sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
  if (ordered.length < 2) return [];

  const results = [];
  // 마스터(가장 잦은 구역)의 실제 측정일
  let masterDates = calcMeasurements(ordered[0], holidayMap).map(m => m.date);

  for (let i = 1; i < ordered.length; i++) {
    const zone = ordered[i];
    const overrides = { ...(zone.schedule_overrides || {}) };
    const ms = calcMeasurements(zone, holidayMap);
    let changed = false;
    for (const m of ms) {
      const bounds = getDragBounds(m);
      // 마스터 측정일 중 이 측정의 허용 창(window) 안에 있는 날짜
      const candidates = masterDates.filter(d => d >= bounds.min && d <= bounds.max);
      if (candidates.length) {
        candidates.sort((a, b) => Math.abs(a - m.baseDate) - Math.abs(b - m.baseDate));
        const snapped = format(candidates[0], 'yyyy-MM-dd');
        if (overrides[String(m.num)] !== snapped) { overrides[String(m.num)] = snapped; changed = true; }
      }
    }
    const aligned = { ...zone, schedule_overrides: overrides };
    if (changed) results.push({ zoneId: zone.id, schedule_overrides: overrides });
    // 다음 구역은 이미 정렬된 이 구역의 측정일 기준으로 맞춘다 (P3→P2→P1 연쇄)
    masterDates = calcMeasurements(aligned, holidayMap).map(m => m.date);
  }
  return results;
}

function sumPoints(item) {
  return (item.points_surface || 0) + (item.points_float || 0)
       + (item.points_fall || 0) + (item.points_particle || 0);
}

const COMBINED_MAJORS = ['질소가스', '압축공기'];
// 통합 측정(부유/낙하/표면/부유입자 → 하나) 대상인지 — 대분류가 질소가스/압축공기면 참
export function isCombinedCat(cat, cfg) {
  return COMBINED_MAJORS.includes(getMajorCat(cat, cfg));
}
const COMBINED_CATS = { includes: (c) => isCombinedCat(c) };

// Re-balance a single month's measurements per-type per-category.
// capacities = { surface, float, fall, particle, combined }
// - surface/float/fall/particle: daily cap per type, evaluated PER CATEGORY
// - combined: daily total cap for 질소가스+압축공기 together
// Returns { [zoneId]: { [num]: 'yyyy-MM-dd' } } of new overrides to persist.
export function optimizeMonthSchedule({ zones, tempSchedules = [], completions = new Set(), year, month, capacities, holidayMap = {}, namedGroups = [] }) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const TYPES = ['surface', 'float', 'fall', 'particle'];

  const events = [];
  zones.forEach(zone => {
    if (!zone.schedule_start) return;
    // 질소가스·압축공기는 통합 측정값(points_float) 하나만 사용한다.
    // (구형 데이터에 남아있는 낙하/표면/부유입자 값을 합산하지 않도록)
    const combined = COMBINED_CATS.includes(zone.category);
    const pts = combined ? {
      surface: 0, float: zone.points_float || 0, fall: 0, particle: 0,
    } : {
      surface: zone.points_surface || 0,
      float:   zone.points_float   || 0,
      fall:    zone.points_fall    || 0,
      particle: zone.points_particle || 0,
    };
    const ptTotal = pts.surface + pts.float + pts.fall + pts.particle;
    calcMeasurements(zone, holidayMap).forEach(m => {
      const ds = format(m.date, 'yyyy-MM-dd');
      if (!ds.startsWith(prefix)) return;
      events.push({ zoneId: zone.id, num: m.num, pts, ptTotal, category: zone.category,
                    bounds: getDragBounds(m), ds, done: completions.has(`${zone.id}_${m.num}`) });
    });
  });

  // catLoad[cat][date][type]: per-category per-type daily points
  const catLoad = {};
  // combinedLoad[date]: 질소가스+압축공기 total per day (event portion)
  const combinedLoad = {};
  // tempCombined[date]: temp schedule points (no category, contributes to combined)
  const tempCombined = {};

  tempSchedules.forEach(t => {
    if (!t.date || !t.date.startsWith(prefix)) return;
    tempCombined[t.date] = (tempCombined[t.date] || 0) + sumPoints(t);
  });
  events.forEach(e => {
    if (!catLoad[e.category]) catLoad[e.category] = {};
    const cl = catLoad[e.category][e.ds] || (catLoad[e.category][e.ds] = { surface:0, float:0, fall:0, particle:0 });
    TYPES.forEach(t => { cl[t] += e.pts[t]; });
    if (COMBINED_CATS.includes(e.category)) {
      combinedLoad[e.ds] = (combinedLoad[e.ds] || 0) + e.ptTotal;
    }
  });

  const effCombined = ds => (combinedLoad[ds] || 0) + (tempCombined[ds] || 0);

  const windowDays = bounds => {
    const days = [];
    let d = new Date(bounds.min);
    while (d <= bounds.max) {
      const ds = format(d, 'yyyy-MM-dd');
      if (ds.startsWith(prefix) && isWorkingDay(d, holidayMap)) days.push(ds);
      d = addDays(d, 1);
    }
    return days;
  };

  const movable = events.filter(e => !e.done && e.ptTotal > 0);
  movable.forEach(e => { e.win = windowDays(e.bounds); });

  const overrides = {};
  const maxIter = movable.length * 10 + 50;

  for (let iter = 0; iter < maxIter; iter++) {
    // Find worst violation: (kind='type', cat, ds, type) or (kind='combined', ds)
    let worst = null, worstExcess = 0;

    for (const cat in catLoad) {
      for (const ds in catLoad[cat]) {
        const cl = catLoad[cat][ds];
        for (const t of TYPES) {
          const cap = capacities[t];
          if (cap > 0 && cl[t] > cap) {
            const ex = cl[t] - cap;
            if (ex > worstExcess) { worstExcess = ex; worst = { kind: 'type', cat, ds, type: t }; }
          }
        }
      }
    }
    for (const ds in combinedLoad) {
      const eff = effCombined(ds);
      const cap = capacities.combined;
      if (cap > 0 && eff > cap) {
        const ex = eff - cap;
        if (ex > worstExcess) { worstExcess = ex; worst = { kind: 'combined', ds }; }
      }
    }
    if (!worst) break;

    let best = null;
    if (worst.kind === 'type') {
      for (const e of movable) {
        if (e.category !== worst.cat || e.ds !== worst.ds || e.win.length < 2 || e.pts[worst.type] <= 0) continue;
        for (const target of e.win) {
          if (target === e.ds) continue;
          const targetCl = catLoad[e.category]?.[target] || { surface:0, float:0, fall:0, particle:0 };
          const newVal = targetCl[worst.type] + e.pts[worst.type];
          if (newVal < catLoad[worst.cat][worst.ds][worst.type] && (!best || newVal < best.metric)) {
            best = { e, target, metric: newVal };
          }
        }
      }
    } else {
      for (const e of movable) {
        if (!COMBINED_CATS.includes(e.category) || e.ds !== worst.ds || e.win.length < 2) continue;
        for (const target of e.win) {
          if (target === e.ds) continue;
          const newCombined = effCombined(target) + e.ptTotal;
          if (newCombined < effCombined(worst.ds) && (!best || newCombined < best.metric)) {
            best = { e, target, metric: newCombined };
          }
        }
      }
    }
    if (!best) break;

    const { e, target } = best;
    const fromCl = catLoad[e.category][e.ds];
    TYPES.forEach(t => { fromCl[t] -= e.pts[t]; });
    if (!catLoad[e.category][target]) catLoad[e.category][target] = { surface:0, float:0, fall:0, particle:0 };
    TYPES.forEach(t => { catLoad[e.category][target][t] += e.pts[t]; });
    if (COMBINED_CATS.includes(e.category)) {
      combinedLoad[e.ds] = (combinedLoad[e.ds] || 0) - e.ptTotal;
      combinedLoad[target] = (combinedLoad[target] || 0) + e.ptTotal;
    }
    e.ds = target;
    overrides[e.zoneId] = { ...(overrides[e.zoneId] || {}), [e.num]: target };
  }

  // Post-optimization: consolidate same-group measurements to the same day within each period.
  // Capacity constraints are respected; if a day can't fit all group members, skip that cluster.
  if (namedGroups.length > 0) {
    const zoneToGroup = new Map();
    namedGroups.forEach(g => { (g.zoneIds || []).forEach(zid => zoneToGroup.set(zid, g.id)); });

    const groupEvtMap = new Map();
    events.forEach(e => {
      const gid = zoneToGroup.get(e.zoneId);
      if (gid == null) return;
      if (!groupEvtMap.has(gid)) groupEvtMap.set(gid, []);
      groupEvtMap.get(gid).push(e);
    });

    groupEvtMap.forEach(gevts => {
      if (gevts.length < 2) return;

      // Cluster events whose measurement-period windows overlap
      const visited = new Set();
      for (let i = 0; i < gevts.length; i++) {
        if (visited.has(i)) continue;
        const cluster = [i];
        visited.add(i);
        for (let j = i + 1; j < gevts.length; j++) {
          if (visited.has(j)) continue;
          const overlaps = cluster.some(ci => {
            const a = gevts[ci], b = gevts[j];
            return a.bounds.max >= b.bounds.min && a.bounds.min <= b.bounds.max;
          });
          if (overlaps) { cluster.push(j); visited.add(j); }
        }

        const clusterEvts = cluster.map(ci => gevts[ci]);
        if (clusterEvts.length < 2) continue;

        const movableCluster = clusterEvts.filter(e => !e.done && e.ptTotal > 0 && e.win && e.win.length > 0);
        if (movableCluster.length < 1) continue;

        // Intersection of all movable events' allowed day windows
        const commonDays = movableCluster.reduce(
          (days, e) => days.filter(d => e.win.includes(d)),
          movableCluster[0].win.slice()
        );
        if (commonDays.length === 0) continue;

        // Prefer days where already-completed events in this cluster are scheduled
        const doneDays = new Set(clusterEvts.filter(e => e.done || e.ptTotal === 0).map(e => e.ds));
        const tryDays = commonDays.filter(d => doneDays.has(d)).length > 0
          ? commonDays.filter(d => doneDays.has(d))
          : commonDays;

        // 같은 그룹·같은 주기의 측정은 항상 같은 날로 모은다.
        // 용량을 지키는 날을 우선하되, 그런 날이 없으면 부하가 가장 낮은
        // 공통 가능일로 전원 함께 이동한다(그룹 단합 우선 — 한 건이라도
        // 옮겨야 하면 전부 같이 옮긴다).
        let bestDay = null, bestLoad = Infinity;        // 용량 만족
        let fallbackDay = null, fallbackLoad = Infinity; // 용량 초과 허용
        for (const day of tryDays) {
          // Delta on target day if all movable events move there
          const catDelta = {};
          let combDelta = 0;
          for (const e of movableCluster) {
            if (e.ds === day) continue;
            if (!catDelta[e.category]) catDelta[e.category] = { surface:0, float:0, fall:0, particle:0 };
            TYPES.forEach(t => { catDelta[e.category][t] += e.pts[t]; });
            if (COMBINED_CATS.includes(e.category)) combDelta += e.ptTotal;
          }

          let valid = true;
          for (const cat in catDelta) {
            const dl = catLoad[cat]?.[day] || {};
            for (const t of TYPES) {
              if (capacities[t] > 0 && (dl[t] || 0) + catDelta[cat][t] > capacities[t]) { valid = false; break; }
            }
            if (!valid) break;
          }
          if (valid && combDelta > 0 && capacities.combined > 0 && effCombined(day) + combDelta > capacities.combined) valid = false;

          const load = Object.values(catLoad).reduce((s, cm) => {
            const dl = cm[day];
            return s + (dl ? TYPES.reduce((ss, t) => ss + dl[t], 0) : 0);
          }, 0);
          if (load < fallbackLoad) { fallbackLoad = load; fallbackDay = day; }
          if (valid && load < bestLoad) { bestLoad = load; bestDay = day; }
        }

        const targetDay = bestDay || fallbackDay;
        if (!targetDay) continue;

        for (const e of movableCluster) {
          if (e.ds === targetDay) continue;
          const fc = catLoad[e.category]?.[e.ds];
          if (fc) TYPES.forEach(t => { fc[t] -= e.pts[t]; });
          if (!catLoad[e.category]) catLoad[e.category] = {};
          if (!catLoad[e.category][targetDay]) catLoad[e.category][targetDay] = { surface:0, float:0, fall:0, particle:0 };
          TYPES.forEach(t => { catLoad[e.category][targetDay][t] += e.pts[t]; });
          if (COMBINED_CATS.includes(e.category)) {
            combinedLoad[e.ds] = (combinedLoad[e.ds] || 0) - e.ptTotal;
            combinedLoad[targetDay] = (combinedLoad[targetDay] || 0) + e.ptTotal;
          }
          e.ds = targetDay;
          overrides[e.zoneId] = { ...(overrides[e.zoneId] || {}), [e.num]: targetDay };
        }
      }
    });
  }

  return overrides;
}

// Build a date→name map for a given year range, expanding recurring holiday defs.
export function buildHolidayMap(holidayDefs, fromYear, toYear) {
  const map = {};
  const pad = n => String(n).padStart(2, '0');
  // 모든 발생일 수집 (대체공휴일 처리를 위해 기본 공휴일을 먼저 모두 등록한 뒤 처리)
  const occurrences = []; // { date, name, substitute }
  holidayDefs.forEach(h => {
    const sub = !!h.substitute;
    const push = dateStr => occurrences.push({ date: dateStr, name: h.name, substitute: sub });
    if (h.lunar) {
      // 음력 공휴일: 저장된 date는 'L'+음력ISO. 양력으로 변환해 등록.
      const [ly, lmm, ldd] = h.date.replace(/^L/, '').split('-').map(Number);
      const conv = (yr) => {
        const sol = lunarToSolar(yr, lmm, ldd, !!h.leapMonth);
        if (sol) push(format(sol, 'yyyy-MM-dd'));
      };
      if (!h.repeat || h.repeat.type === 'none') {
        conv(ly); // 1회성: 입력한 음력 연도 그대로
      } else {
        // 매년 반복(음력은 yearly만 의미 있음)
        for (let yr = fromYear; yr <= toYear; yr++) conv(yr);
      }
      return;
    }
    if (!h.repeat || h.repeat.type === 'none') {
      push(h.date);
    } else if (h.repeat.type === 'yearly') {
      const [, mm, dd] = h.date.split('-');
      for (let yr = fromYear; yr <= toYear; yr++) push(`${yr}-${mm}-${dd}`);
    } else {
      for (let yr = fromYear; yr <= toYear; yr++) {
        for (let mo = 1; mo <= 12; mo++) {
          const daysInMo = new Date(yr, mo, 0).getDate();
          if (h.repeat.type === 'monthly') {
            const d = Number(h.date.split('-')[2]);
            if (d <= daysInMo) push(`${yr}-${pad(mo)}-${pad(d)}`);
          } else if (h.repeat.type === 'nth-weekday') {
            const { nth, dow } = h.repeat;
            let count = 0;
            for (let d = 1; d <= daysInMo; d++) {
              if (new Date(yr, mo - 1, d).getDay() === dow) {
                count++;
                if (count === nth) { push(`${yr}-${pad(mo)}-${pad(d)}`); break; }
              }
            }
          }
        }
      }
    }
  });

  // 1차: 기본 공휴일 등록
  occurrences.forEach(o => { map[o.date] = o.name; });

  // 2차: 대체공휴일 — 발생일이 주말이면 다음 평일(비공휴일)을 휴무로 지정
  occurrences.forEach(o => {
    if (!o.substitute) return;
    const base = new Date(o.date + 'T00:00:00');
    const dow = base.getDay();
    if (dow !== 0 && dow !== 6) return; // 주말이 아니면 대체 없음
    let d = base;
    for (let i = 0; i < 14; i++) {
      d = addDays(d, 1);
      const wd = d.getDay();
      const ds = format(d, 'yyyy-MM-dd');
      if (wd !== 0 && wd !== 6 && !map[ds]) { map[ds] = `${o.name} 대체공휴일`; break; }
    }
  });

  return map;
}

// Auto-create cascade schedule zones for P1→P2→P3→유지관리.
// Gaps: P1 end +3 weeks → P2; P2/P3 end +1 month → next grade. Skips weekends & holidays.
// Returns array of { zoneData } to upsert; caller handles persistence.
export function computeCascadeSchedules(startZone, allZones, holidayMap = {}) {
  const PROGRESSION = ['P1', 'P2', 'P3', '유지관리'];
  const startIdx = PROGRESSION.indexOf(startZone.grade);
  if (startIdx < 0 || startIdx >= PROGRESSION.length - 1) return [];

  const results = [];
  let currentZone = startZone;

  for (let i = startIdx + 1; i < PROGRESSION.length; i++) {
    const nextGrade = PROGRESSION[i];
    const ms = calcMeasurements(currentZone);
    if (!ms.length) break;

    const endDate = ms[ms.length - 1].baseDate;
    let nextDate = nextGrade === 'P2' ? addDays(endDate, 21) : addMonths(endDate, 1);

    let iter = 0;
    while (iter < 14 && (nextDate.getDay() === 0 || nextDate.getDay() === 6 || !!holidayMap[format(nextDate, 'yyyy-MM-dd')])) {
      nextDate = addDays(nextDate, 1);
      iter++;
    }

    const nextStartStr = format(nextDate, 'yyyy-MM-dd');
    const knownZones = [...allZones, ...results.map(r => r.zoneData)];
    const existing = knownZones.find(z =>
      z.name === startZone.name && z.category === startZone.category && z.grade === nextGrade
    );

    const zoneData = existing
      ? { ...existing, schedule_start: nextStartStr, schedule_overrides: {} }
      : { name: startZone.name, category: startZone.category, grade: nextGrade, clean_grade: startZone.clean_grade ?? null, schedule_start: nextStartStr, schedule_overrides: {}, monthly_weekday_rule: null };

    results.push({ zoneData });
    currentZone = zoneData;
  }

  return results;
}
