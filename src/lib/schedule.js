import { addDays, addMonths, addYears, startOfWeek, endOfWeek, startOfMonth, endOfMonth, format } from 'date-fns';

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

function isOverrideValid(overrideDate, baseDate, type) {
  if (type === 'daily') {
    const min = startOfWeek(baseDate, { weekStartsOn: 1 });
    const max = endOfWeek(baseDate, { weekStartsOn: 1 });
    return overrideDate >= min && overrideDate <= max;
  }
  if (type === 'weekly' || type === 'biweekly') {
    const min = startOfWeek(baseDate, { weekStartsOn: 1 });
    const max = endOfWeek(baseDate, { weekStartsOn: 1 });
    return overrideDate >= min && overrideDate <= max;
  }
  if (type === 'monthly' || type === 'quarterly') {
    return overrideDate.getFullYear() === baseDate.getFullYear() &&
           overrideDate.getMonth() === baseDate.getMonth();
  }
  return false;
}

// 카테고리·등급별 기본 측정주기 (사용자가 설정에서 변경 가능)
// phase: { count: 횟수, intervalDays: 간격(일) | null, type: 'daily'|'weekly'|'biweekly'|'monthly'|'quarterly' }
export const DEFAULT_SCHEDULE_SPECS = {
  '공조': {
    'P1':     [{ count: 7,  intervalDays: 1,    type: 'daily' }],
    'P2':     [{ count: 4,  intervalDays: 7,    type: 'weekly' },
               { count: 6,  intervalDays: 14,   type: 'biweekly' }],
    'P3':     [{ count: 12, intervalDays: null, type: 'monthly' }],
    '유지관리': [{ count: 36, intervalDays: null, type: 'monthly' }],
  },
  '압축공기': {
    'P1':     [{ count: 7,  intervalDays: 1,    type: 'daily' }],
    'P2':     [{ count: 13, intervalDays: 14,   type: 'biweekly' }],
    'P3':     [{ count: 12, intervalDays: null, type: 'monthly' }],
    '유지관리': [{ count: 12, intervalDays: null, type: 'quarterly' }],
  },
  '질소가스': {
    'P1':     [{ count: 7,  intervalDays: 1,    type: 'daily' }],
    'P2':     [{ count: 13, intervalDays: 14,   type: 'biweekly' }],
    'P3':     [{ count: 12, intervalDays: null, type: 'monthly' }],
    '유지관리': [{ count: 12, intervalDays: null, type: 'quarterly' }],
  },
};

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

export function calcMeasurements(zone, holidayMap = {}) {
  if (!zone.schedule_start) return [];
  const spec = getScheduleSpec(zone.category, zone.grade);
  if (!spec) return [];

  const overrides = zone.schedule_overrides || {};
  const weekdayRule = zone.monthly_weekday_rule || null;
  const measurements = [];
  let num = 1;
  let baseDate = new Date(zone.schedule_start + 'T00:00:00');
  let lastBaseDate = null;
  const total = spec.reduce((s, p) => s + p.count, 0);

  for (let phaseIdx = 0; phaseIdx < spec.length; phaseIdx++) {
    const phase = spec[phaseIdx];

    // Phase transition: advance baseDate by new phase's interval after last measurement
    if (phaseIdx > 0 && lastBaseDate !== null) {
      baseDate = phase.type === 'monthly' ? addMonths(lastBaseDate, 1)
               : phase.type === 'quarterly' ? addMonths(lastBaseDate, 3)
               : addDays(lastBaseDate, phase.intervalDays);
    }

    for (let i = 0; i < phase.count; i++) {
      // Apply weekday rule for monthly measurements
      let effectiveBaseDate = new Date(baseDate);
      if (phase.type === 'monthly' && weekdayRule) {
        effectiveBaseDate = getNthWeekdayOfMonth(
          baseDate.getFullYear(), baseDate.getMonth() + 1,
          weekdayRule.nth, weekdayRule.dow
        );
      }

      const key = String(num);
      const rawOverride = overrides[key] ? new Date(overrides[key] + 'T00:00:00') : null;
      const hasValidOverride = rawOverride && isOverrideValid(rawOverride, effectiveBaseDate, phase.type);
      let scheduledDate;
      if (hasValidOverride) {
        // User/optimizer explicitly placed this measurement — respect it.
        scheduledDate = rawOverride;
      } else {
        // Auto-placed: shift off weekends/holidays to nearest working day in window.
        const bounds = getDragBounds({ type: phase.type, baseDate: effectiveBaseDate });
        scheduledDate = adjustToWorkingDay(effectiveBaseDate, bounds, holidayMap);
      }

      lastBaseDate = new Date(baseDate);
      measurements.push({
        num,
        date: scheduledDate,
        baseDate: effectiveBaseDate,
        type: phase.type,
        isFirst: num === 1,
        isLast: num === total,
      });
      num++;

      if (phase.type === 'monthly') {
        baseDate = addMonths(baseDate, 1);
      } else if (phase.type === 'quarterly') {
        baseDate = addMonths(baseDate, 3);
      } else if (phase.type === 'daily') {
        // Advance to next weekday, skipping Sat/Sun
        let next = addDays(baseDate, 1);
        while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
        baseDate = next;
      } else {
        baseDate = addDays(baseDate, phase.intervalDays);
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
  const { type, baseDate } = measurement;

  if (type === 'daily') {
    return {
      min: startOfWeek(baseDate, { weekStartsOn: 1 }),
      max: endOfWeek(baseDate, { weekStartsOn: 1 }),
    };
  }
  if (type === 'weekly' || type === 'biweekly') {
    return {
      min: startOfWeek(baseDate, { weekStartsOn: 1 }),
      max: endOfWeek(baseDate, { weekStartsOn: 1 }),
    };
  }
  if (type === 'monthly' || type === 'quarterly') {
    return { min: startOfMonth(baseDate), max: endOfMonth(baseDate) };
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

const COMBINED_CATS = ['질소가스', '압축공기'];

// Re-balance a single month's measurements per-type per-category.
// capacities = { surface, float, fall, particle, combined }
// - surface/float/fall/particle: daily cap per type, evaluated PER CATEGORY
// - combined: daily total cap for 질소가스+압축공기 together
// Returns { [zoneId]: { [num]: 'yyyy-MM-dd' } } of new overrides to persist.
export function optimizeMonthSchedule({ zones, tempSchedules = [], completions = new Set(), year, month, capacities, holidayMap = {} }) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const TYPES = ['surface', 'float', 'fall', 'particle'];

  const events = [];
  zones.forEach(zone => {
    if (!zone.schedule_start) return;
    const pts = {
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

  return overrides;
}

// Build a date→name map for a given year range, expanding recurring holiday defs.
export function buildHolidayMap(holidayDefs, fromYear, toYear) {
  const map = {};
  holidayDefs.forEach(h => {
    if (!h.repeat || h.repeat.type === 'none') {
      map[h.date] = h.name;
      return;
    }
    if (h.repeat.type === 'yearly') {
      const [, mm, dd] = h.date.split('-');
      for (let yr = fromYear; yr <= toYear; yr++) map[`${yr}-${mm}-${dd}`] = h.name;
      return;
    }
    for (let yr = fromYear; yr <= toYear; yr++) {
      for (let mo = 1; mo <= 12; mo++) {
        const daysInMo = new Date(yr, mo, 0).getDate();
        if (h.repeat.type === 'monthly') {
          const d = Number(h.date.split('-')[2]);
          if (d <= daysInMo) map[`${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`] = h.name;
        } else if (h.repeat.type === 'nth-weekday') {
          const { nth, dow } = h.repeat;
          let count = 0;
          for (let d = 1; d <= daysInMo; d++) {
            if (new Date(yr, mo - 1, d).getDay() === dow) {
              count++;
              if (count === nth) {
                map[`${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`] = h.name;
                break;
              }
            }
          }
        }
      }
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
