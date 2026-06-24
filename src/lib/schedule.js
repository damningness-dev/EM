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

export function getScheduleSpec(category, grade) {
  // 압축공기·질소가스 유지관리: 분기 1회 × 3년 = 12회
  if (grade === '유지관리' && (category === '압축공기' || category === '질소가스')) {
    return [{ count: 12, intervalDays: null, type: 'quarterly' }];
  }
  if (!['P1', 'P2', 'P3'].includes(grade)) return null;
  const isHVAC = category === '공조';

  if (grade === 'P1') {
    return [{ count: 7, intervalDays: 1, type: 'daily' }];
  }
  if (grade === 'P2') {
    if (isHVAC) {
      return [
        { count: 4, intervalDays: 7, type: 'weekly' },
        { count: 6, intervalDays: 14, type: 'biweekly' },
      ];
    }
    return [{ count: 13, intervalDays: 14, type: 'biweekly' }];
  }
  if (grade === 'P3') {
    return [{ count: 12, intervalDays: null, type: 'monthly' }];
  }
  return null;
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

function sumPoints(item) {
  return (item.points_surface || 0) + (item.points_float || 0)
       + (item.points_fall || 0) + (item.points_particle || 0);
}

// Re-balance a single month's measurements so no day's total points exceed
// `capacity`. Movable (non-completed) measurements are shifted within their own
// cycle window to the least-loaded working day. Temp schedules are fixed load.
// Returns { [zoneId]: { [num]: 'yyyy-MM-dd' } } of new overrides to persist.
export function optimizeMonthSchedule({ zones, tempSchedules = [], completions = new Set(), year, month, capacity, holidayMap = {} }) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;

  // Collect this month's measurement events.
  const events = [];
  zones.forEach(zone => {
    if (!zone.schedule_start) return;
    const pts = sumPoints(zone);
    calcMeasurements(zone, holidayMap).forEach(m => {
      const ds = format(m.date, 'yyyy-MM-dd');
      if (!ds.startsWith(prefix)) return;
      events.push({
        zoneId: zone.id,
        num: m.num,
        pts,
        bounds: getDragBounds(m),
        ds,
        done: completions.has(`${zone.id}_${m.num}`),
      });
    });
  });

  // Daily load: movable events + fixed temp schedules.
  const load = {};
  tempSchedules.forEach(t => {
    if (!t.date || !t.date.startsWith(prefix)) return;
    load[t.date] = (load[t.date] || 0) + sumPoints(t);
  });
  events.forEach(e => { load[e.ds] = (load[e.ds] || 0) + e.pts; });

  // Working days (in this month) within a measurement's window.
  const windowDays = (bounds) => {
    const days = [];
    let d = new Date(bounds.min);
    while (d <= bounds.max) {
      const ds = format(d, 'yyyy-MM-dd');
      if (ds.startsWith(prefix) && isWorkingDay(d, holidayMap)) days.push(ds);
      d = addDays(d, 1);
    }
    return days;
  };

  const movable = events.filter(e => !e.done && e.pts > 0);
  movable.forEach(e => { e.win = windowDays(e.bounds); });

  const overrides = {};
  const maxIter = movable.length * 8 + 50;
  for (let iter = 0; iter < maxIter; iter++) {
    // Most overloaded day.
    let day = null, dayLoad = -1;
    for (const ds in load) {
      if (load[ds] > capacity && load[ds] > dayLoad) { day = ds; dayLoad = load[ds]; }
    }
    if (!day) break;

    // Best beneficial relocation of a movable event off `day`.
    let best = null;
    for (const e of movable) {
      if (e.ds !== day || e.win.length < 2) continue;
      for (const target of e.win) {
        if (target === e.ds) continue;
        const newTarget = (load[target] || 0) + e.pts;
        if (newTarget < dayLoad && (!best || newTarget < best.newTarget)) {
          best = { e, target, newTarget };
        }
      }
    }
    if (!best) break;

    load[best.e.ds] -= best.e.pts;
    load[best.target] = (load[best.target] || 0) + best.e.pts;
    best.e.ds = best.target;
    overrides[best.e.zoneId] = { ...(overrides[best.e.zoneId] || {}), [best.e.num]: best.target };
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
      : { name: startZone.name, category: startZone.category, grade: nextGrade, schedule_start: nextStartStr, schedule_overrides: {}, monthly_weekday_rule: null };

    results.push({ zoneData });
    currentZone = zoneData;
  }

  return results;
}
