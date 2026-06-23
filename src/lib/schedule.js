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
  if (type === 'monthly') {
    return overrideDate.getFullYear() === baseDate.getFullYear() &&
           overrideDate.getMonth() === baseDate.getMonth();
  }
  return false;
}

export function getScheduleSpec(category, grade) {
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

export function calcMeasurements(zone) {
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
      baseDate = phase.type === 'monthly'
        ? addMonths(lastBaseDate, 1)
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
      const scheduledDate = (rawOverride && isOverrideValid(rawOverride, effectiveBaseDate, phase.type))
        ? rawOverride
        : effectiveBaseDate;

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
  if (zone.grade === '유지관리' && zone.schedule_start) {
    return addYears(new Date(zone.schedule_start + 'T00:00:00'), 3);
  }
  const ms = calcMeasurements(zone);
  return ms.length ? ms[ms.length - 1].baseDate : null;
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
  if (type === 'monthly') {
    return { min: startOfMonth(baseDate), max: endOfMonth(baseDate) };
  }
  return { min: baseDate, max: baseDate };
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
