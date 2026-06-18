import { addDays, addMonths, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';

function isOverrideValid(overrideDate, baseDate, type) {
  if (type === 'daily') {
    return overrideDate.toDateString() === baseDate.toDateString();
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
  const measurements = [];
  let num = 1;
  let baseDate = new Date(zone.schedule_start + 'T00:00:00');
  let lastBaseDate = null;

  for (let phaseIdx = 0; phaseIdx < spec.length; phaseIdx++) {
    const phase = spec[phaseIdx];

    // Phase transition: first measurement of new phase is (new phase's interval) after last measurement
    if (phaseIdx > 0 && lastBaseDate !== null) {
      baseDate = phase.type === 'monthly'
        ? addMonths(lastBaseDate, 1)
        : addDays(lastBaseDate, phase.intervalDays);
    }

    for (let i = 0; i < phase.count; i++) {
      const key = String(num);
      const rawOverride = overrides[key] ? new Date(overrides[key] + 'T00:00:00') : null;
      const scheduledDate = (rawOverride && isOverrideValid(rawOverride, new Date(baseDate), phase.type))
        ? rawOverride
        : new Date(baseDate);

      lastBaseDate = new Date(baseDate);
      measurements.push({
        num,
        date: scheduledDate,
        baseDate: new Date(baseDate),
        type: phase.type,
      });
      num++;

      baseDate = phase.type === 'monthly'
        ? addMonths(baseDate, 1)
        : addDays(baseDate, phase.intervalDays);
    }
  }

  return measurements;
}

export function calcEndDate(zone) {
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
    // Daily measurements are fixed — cannot move to another day
    return { min: baseDate, max: baseDate };
  }
  if (type === 'weekly' || type === 'biweekly') {
    // Both weekly and biweekly must stay within the same ISO week (Mon–Sun)
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
