import { addDays, addMonths, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';

export function getScheduleSpec(category, grade) {
  if (!['P1', 'P2', 'P3'].includes(grade)) return null;
  const isHVAC = category === '공조';

  if (grade === 'P1') {
    return [{ count: 52, intervalDays: 7, type: 'weekly' }];
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

  for (const phase of spec) {
    for (let i = 0; i < phase.count; i++) {
      const key = String(num);
      const scheduledDate = overrides[key]
        ? new Date(overrides[key] + 'T00:00:00')
        : new Date(baseDate);

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

  if (type === 'weekly') {
    return {
      min: startOfWeek(baseDate, { weekStartsOn: 1 }),
      max: endOfWeek(baseDate, { weekStartsOn: 1 }),
    };
  }
  if (type === 'biweekly') {
    return { min: addDays(baseDate, -7), max: addDays(baseDate, 7) };
  }
  if (type === 'monthly') {
    return { min: startOfMonth(baseDate), max: endOfMonth(baseDate) };
  }
  return { min: baseDate, max: baseDate };
}
