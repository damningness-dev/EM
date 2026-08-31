// 공휴일 정의(data.holidays) → 날짜맵 변환 — src/lib/schedule.js의 buildHolidayMap +
// src/lib/lunar.js의 lunarToSolar를 메인 프로세스(CommonJS)에서도 쓸 수 있도록 그대로 이식한 것.
// 렌더러(src/lib)는 electron-builder 패키징 대상(files)에 포함되지 않아 require할 수 없어
// 별도로 유지한다 — 두 로직은 항상 같은 결과를 내야 하므로 schedule.js/lunar.js를 고치면
// 여기도 함께 고쳐야 한다.
const { addDays, format } = require('date-fns');

// ── lunar.js 이식분 ─────────────────────────────────────────────────────────
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
function leapMonth(y) { return LUNAR_INFO[y - MIN_YEAR] & 0xf; }
function leapDays(y) { if (leapMonth(y)) return (LUNAR_INFO[y - MIN_YEAR] & 0x10000) ? 30 : 29; return 0; }
function monthDays(y, m) { return (LUNAR_INFO[y - MIN_YEAR] & (0x10000 >> m)) ? 30 : 29; }
function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - MIN_YEAR] & i) ? 1 : 0;
  return sum + leapDays(y);
}
const BASE_UTC = Date.UTC(1900, 0, 31);
const KR_LUNAR_OVERRIDES = { '2027-1-1': '2027-02-07' };
function lunarToSolar(y, m, d, isLeap = false) {
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  const ov = KR_LUNAR_OVERRIDES[`${y}-${m}-${d}${isLeap ? 'L' : ''}`];
  if (ov) { const [oy, om, od] = ov.split('-').map(Number); return new Date(oy, om - 1, od); }
  let offset = 0;
  for (let i = MIN_YEAR; i < y; i++) offset += lYearDays(i);
  const leap = leapMonth(y);
  for (let i = 1; i < m; i++) {
    offset += monthDays(y, i);
    if (leap === i) offset += leapDays(y);
  }
  if (isLeap && leap === m) offset += monthDays(y, m);
  offset += d - 1;
  const utc = new Date(BASE_UTC + offset * 86400000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

// ── schedule.js의 buildHolidayMap 이식분 ────────────────────────────────────
function buildHolidayMap(holidayDefs, fromYear, toYear) {
  const map = {};
  const pad = n => String(n).padStart(2, '0');
  const occurrences = [];
  (holidayDefs || []).forEach(h => {
    const sub = !!h.substitute;
    const before = Math.max(0, parseInt(h.bridgeBefore) || 0);
    const after = Math.max(0, parseInt(h.bridgeAfter) || 0);
    const push = dateStr => occurrences.push({ date: dateStr, name: h.name, substitute: sub, before, after });
    if (h.lunar) {
      const [ly, lmm, ldd] = h.date.replace(/^L/, '').split('-').map(Number);
      const conv = (yr) => {
        const sol = lunarToSolar(yr, lmm, ldd, !!h.leapMonth);
        if (sol) push(format(sol, 'yyyy-MM-dd'));
      };
      if (!h.repeat || h.repeat.type === 'none') {
        conv(ly);
      } else {
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

  occurrences.forEach(o => { map[o.date] = o.name; });

  occurrences.forEach(o => {
    if (!o.before && !o.after) return;
    const base = new Date(o.date + 'T00:00:00');
    for (let i = 1; i <= o.before; i++) { const ds = format(addDays(base, -i), 'yyyy-MM-dd'); if (!map[ds]) map[ds] = `${o.name} 연휴`; }
    for (let i = 1; i <= o.after; i++) { const ds = format(addDays(base, i), 'yyyy-MM-dd'); if (!map[ds]) map[ds] = `${o.name} 연휴`; }
  });

  occurrences.forEach(o => {
    if (!o.substitute) return;
    const base = new Date(o.date + 'T00:00:00');
    const block = [];
    for (let i = o.before; i >= 1; i--) block.push(addDays(base, -i));
    block.push(base);
    for (let i = 1; i <= o.after; i++) block.push(addDays(base, i));
    const weekendCount = block.filter(d => d.getDay() === 0 || d.getDay() === 6).length;
    if (weekendCount === 0) return;
    let d = block[block.length - 1], added = 0;
    for (let guard = 0; guard < 30 && added < weekendCount; guard++) {
      d = addDays(d, 1);
      const wd = d.getDay(), ds = format(d, 'yyyy-MM-dd');
      if (wd !== 0 && wd !== 6 && !map[ds]) { map[ds] = `${o.name} 대체공휴일`; added++; }
    }
  });

  return map;
}

module.exports = { buildHolidayMap, lunarToSolar };
