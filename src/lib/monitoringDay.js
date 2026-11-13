// 월별 모니터링 일정(구역별 측정 일정)을 날짜별로 계산하는 공용 함수.
// 달력(CalendarView)과 TEST 업무 배치판의 [환경모니터링] 구역이 같은 규칙으로 같은 결과를 보게 하려고 한곳에 둔다.
import { format } from 'date-fns';
import { calcMeasurements, GRADE_PRIORITY, DEFAULT_SCHEDULE_SPECS, getMajorCat } from './schedule';

// 저장된 주기 설정을 기본 설정 위에 합친다(기본 분류 + 사용자가 추가한 소분류, __major 같은 메타 키 보존).
export function mergeScheduleConfig(backend) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_SPECS));
  if (backend && typeof backend === 'object') {
    for (const cat of Object.keys(backend)) {
      if (!base[cat]) base[cat] = {};
      const src = backend[cat];
      if (src && typeof src === 'object') {
        for (const key of Object.keys(src)) {
          if (Array.isArray(src[key]) || key.startsWith('__')) base[cat][key] = src[key];
        }
      }
    }
  }
  return base;
}

// 일정관리 전체 순서: 구역명 그룹(분류+이름)의 최소 sort_order 순, 그룹 안에서는 등급 우선순위 순.
export function buildZoneOrderRank(zones) {
  const groups = {};
  zones.forEach(z => {
    const key = `${z.category}|||${z.name}`;
    (groups[key] || (groups[key] = { name: z.name, zones: [] })).zones.push(z);
  });
  const arr = Object.values(groups);
  arr.forEach(g => g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)));
  arr.sort((a, b) =>
    (Math.min(...a.zones.map(z => z.sort_order ?? 1e9)) - Math.min(...b.zones.map(z => z.sort_order ?? 1e9)))
    || a.name.localeCompare(b.name)
  );
  const rank = {};
  let i = 0;
  arr.forEach(g => g.zones.forEach(z => { rank[z.id] = i++; }));
  return rank;
}

// 날짜('yyyy-MM-dd') → [{ zone, measurement }]. 같은 구역명의 서로 다른 등급(P1/P2/P3/유지관리)이 같은 날에
// 겹치지 않도록 구역명 그룹 단위로 공유 usedDates를 쓰고, 시작일 → 등급 우선순위 순으로 자리를 잡는다.
export function buildScheduleByDate(zones, scheduleAvoid, zoneOrderRank) {
  const map = {};
  const byName = {};
  zones.forEach(zone => {
    if (!zone.schedule_start) return;
    const key = `${zone.category}|||${zone.name}`;
    (byName[key] || (byName[key] = [])).push(zone);
  });
  Object.values(byName).forEach(groupZones => {
    groupZones.sort((a, b) =>
      (a.schedule_start || '').localeCompare(b.schedule_start || '')
      || (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)
    );
    const used = new Set();
    groupZones.forEach(zone => {
      calcMeasurements(zone, scheduleAvoid, used).forEach(m => {
        const key = format(m.date, 'yyyy-MM-dd');
        if (!map[key]) map[key] = [];
        map[key].push({ zone, measurement: m });
      });
    });
  });
  Object.values(map).forEach(arr => arr.sort((a, b) =>
    (zoneOrderRank[a.zone.id] ?? 1e9) - (zoneOrderRank[b.zone.id] ?? 1e9) || a.zone.name.localeCompare(b.zone.name)
  ));
  return map;
}

// 하루 일정을 버튼 목록으로: 구역(또는 임시일정) 하나가 측정 종류별로 나뉘고 측정포인트 수가 붙는다.
//   "AHU-31 부유균 21개,낙하균 21개" / "AHU-31 부유입자 55개" / "AHU-31 표면균 21개" / "005-B-05-2 부유균 3개" …
// 각 버튼 = { key, label, name, segs: [{ text, tone }], types, count }. segs의 tone은 달력의 포인트 칩 색과 같은 종류
// (float 부=파랑, fall 낙=주황, surface 표=초록, particle 입자=분홍, gas 질소=보라, comp 압축=노랑, water 용수=청록).
// 공조(소분류 포함)는 포인트가 없어도 항상 부유균,낙하균 / 부유입자 / 표면균 세 가지,
// 질소가스·압축공기는 항상 부유균 / 부유입자 두 가지(숫자는 같게), 그 밖의 분류는 포인트가 있는 종류만,
// 측정포인트가 하나도 없는 비공조 구역(예: 용수)은 이름만 있는 버튼 하나.
export function monitoringButtons(zoneOrTemp, extra = {}) {
  const z = zoneOrTemp;
  const name = extra.suffix ? `${z.name}${extra.suffix}` : z.name;
  const f = z.points_float || 0, l = z.points_fall || 0, p = z.points_particle || 0, sf = z.points_surface || 0;
  const major = z.category ? getMajorCat(z.category) : '';
  const isAir = major === '공조';
  const isGas = major === '질소가스' || major === '압축공기';
  const gasTone = major === '압축공기' ? 'comp' : 'gas';
  const seg = (text, n, tone) => ({ text: n > 0 ? `${text} ${n}개` : text, tone });
  const mk = (key, segs, types, count) => ({ key, name, segs, label: `${name} ${segs.map(x => x.text).join(',')}`, types, count });
  const out = [];
  if (isGas) {
    out.push(mk('air', [seg('부유균', f, gasTone)], ['부유균'], f));
    // 질소가스·압축공기는 부유균과 부유입자를 같은 지점에서 함께 측정하므로 두 버튼의 숫자는 항상 같다(달력의 질소·압축 칩과 같은 부유균 포인트 수 기준)
    out.push(mk('particle', [seg('부유입자', f, gasTone)], ['부유입자'], f));
    return out;
  }
  if (isAir || f > 0 || l > 0) {
    const segs = [];
    if (isAir || f > 0) segs.push(seg('부유균', f, 'float'));
    if (isAir || l > 0) segs.push(seg('낙하균', l, 'fall'));
    out.push(mk('air', segs, segs.map(x => x.text.split(' ')[0]), f + l));
  }
  if (isAir || p > 0) out.push(mk('particle', [seg('부유입자', p, 'particle')], ['부유입자'], p));
  if (isAir || sf > 0) out.push(mk('surface', [seg('표면균', sf, 'surface')], ['표면균'], sf));
  if (out.length === 0) out.push({ key: 'name', name, segs: [], label: name, types: [], count: 0, tone: major === '용수' ? 'water' : 'name' });
  return out;
}
