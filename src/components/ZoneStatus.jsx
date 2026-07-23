import { useState, useEffect, useMemo } from 'react';
import { fetchZones, fetchScheduleConfig, fetchHolidays, fetchCompletions } from '../lib/api';
import { GRADE_COLORS } from '../data/initialData';
import { calcMeasurements, calcEndDate, buildHolidayMap, setScheduleConfig, getScheduleSpec, GRADE_PRIORITY } from '../lib/schedule';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function fmt(d) { return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—'; }

// 측정주기 표시("월1회", "분기1회" 등) — 구역의 phase 스펙(신형 unit/interval,
// 구형 type/intervalDays 모두 지원)을 사람이 읽을 라벨로 변환한다.
const CYCLE_UNIT_LABEL = { day: '일', week: '주', month: '월', quarter: '분기', half: '반기', year: '년' };
function phaseLabel(p) {
  let unit, interval;
  if (p.unit) { unit = p.unit; interval = p.interval ?? 1; }
  else {
    switch (p.type) {
      case 'daily': unit = 'day'; interval = 1; break;
      case 'weekly': unit = 'week'; interval = 1; break;
      case 'biweekly': unit = 'week'; interval = 2; break;
      case 'monthly': unit = 'month'; interval = 1; break;
      case 'quarterly': unit = 'month'; interval = 3; break;
      default:
        if (p.intervalDays && p.intervalDays % 7 === 0) { unit = 'week'; interval = p.intervalDays / 7; }
        else { unit = 'day'; interval = p.intervalDays ?? 1; }
    }
  }
  // 월 단위 간격은 3/6/12의 배수면 분기/반기/년으로 승격해서 보여준다.
  if (unit === 'month' && interval > 0) {
    if (interval % 12 === 0) { unit = 'year'; interval /= 12; }
    else if (interval % 6 === 0) { unit = 'half'; interval /= 6; }
    else if (interval % 3 === 0) { unit = 'quarter'; interval /= 3; }
  }
  if (unit === 'day') return interval <= 1 ? '매일' : `${interval}일마다`;
  return `${CYCLE_UNIT_LABEL[unit] || unit}${interval}회`;
}
function zoneCycleLabel(zone) {
  const spec = getScheduleSpec(zone.category, zone.grade);
  if (!spec || !spec.length) return null;
  return spec.map(phaseLabel).join(' → ');
}

export default function ZoneStatus({ year, onYearChange }) {
  const [zones, setZones] = useState([]);
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [completions, setCompletions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    Promise.all([fetchZones(), fetchScheduleConfig(), fetchHolidays(), fetchCompletions()])
      .then(([z, cfg, hols, comps]) => {
        if (cfg) setScheduleConfig(cfg);
        setZones(z);
        setHolidayDefs(hols || []);
        setCompletions(new Set((comps || []).map(c => `${c.zoneId}_${c.num}`)));
        setLoading(false);
      });
  }, []);

  const holidayMap = useMemo(() => {
    try { return buildHolidayMap(holidayDefs, year - 1, year + 5); } catch { return {}; }
  }, [holidayDefs, year]);

  // 구역명(분류+이름)으로 묶고, 그룹 내는 등급 우선순위(P1 먼저)
  const groups = useMemo(() => {
    const map = {};
    zones.forEach(z => {
      const key = `${z.category}|||${z.name}`;
      (map[key] || (map[key] = { key, name: z.name, category: z.category, zones: [] })).zones.push(z);
    });
    Object.values(map).forEach(g => g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)));
    let arr = Object.values(map);
    if (search) arr = arr.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
    if (gradeFilter !== 'all') arr = arr.filter(g => g.zones.some(z => z.grade === gradeFilter));
    arr.sort((a, b) => (Math.min(...a.zones.map(z => z.sort_order ?? 1e9)) - Math.min(...b.zones.map(z => z.sort_order ?? 1e9))) || a.name.localeCompare(b.name));
    return arr;
  }, [zones, search, gradeFilter]);

  const todayMid = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);

  function zonePlan(zone) {
    if (!zone.schedule_start) return { measurements: [], total: 0, done: 0, endDate: null };
    let ms = [];
    try { ms = calcMeasurements(zone, holidayMap); } catch { /* ignore */ }
    let endDate = null;
    try { endDate = calcEndDate(zone); } catch { /* ignore */ }
    const done = ms.filter(m => completions.has(`${zone.id}_${m.num}`) || m.date <= todayMid).length;
    return { measurements: ms, total: ms.length, done, endDate };
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">구역별 현황</h1>
        <div className="flex gap-1">
          <button onClick={() => onYearChange(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
          <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
          <button onClick={() => onYearChange(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input type="text" placeholder="구역명 검색..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <div className="flex gap-2 flex-wrap">
          {['all', 'P1', 'P2', 'P3', '유지관리'].map(g => (
            <button key={g} onClick={() => setGradeFilter(g)} className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {g === 'all' ? '전체' : g}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-gray-400">구역을 클릭하면 계획된 측정 일정(몇 회차가 언제인지)을 한눈에 볼 수 있습니다.</p>

      <div className="space-y-2">
        {groups.map(group => {
          const isExp = expanded.has(group.key);
          return (
            <div key={group.key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setExpanded(prev => { const s = new Set(prev); s.has(group.key) ? s.delete(group.key) : s.add(group.key); return s; })}
                className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-50 text-left"
              >
                <span className={`text-xs transition-transform ${isExp ? 'rotate-90 text-blue-500' : 'text-gray-400'}`}>▶</span>
                <span className="font-semibold text-gray-800">{group.name}</span>
                <span className="text-xs text-gray-400">{group.category}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {group.zones.map(z => (
                    <span key={z.id} className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${GRADE_COLORS[z.grade] || 'bg-gray-100 text-gray-600'}`}>{z.grade}</span>
                  ))}
                </div>
              </button>

              {isExp && (
                <div className="border-t border-gray-100 divide-y divide-gray-50">
                  {group.zones.map(zone => {
                    const plan = zonePlan(zone);
                    // 월별 그룹핑
                    const byMonth = {};
                    plan.measurements.forEach(m => {
                      const k = `${m.date.getFullYear()}-${String(m.date.getMonth() + 1).padStart(2, '0')}`;
                      (byMonth[k] || (byMonth[k] = [])).push(m);
                    });
                    const cycleLabel = zoneCycleLabel(zone);
                    return (
                      <div key={zone.id} className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className={`text-[11px] px-2 py-0.5 rounded font-bold ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                          {zone.schedule_start ? (
                            <>
                              <span className="text-xs text-gray-500">시작 {zone.schedule_start} · 종료 {fmt(plan.endDate)}</span>
                              {cycleLabel && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">{cycleLabel}</span>}
                              <span className="text-xs font-semibold text-blue-600">총 {plan.total}회</span>
                              <span className="text-xs text-gray-400">(경과 {plan.done}회)</span>
                            </>
                          ) : (
                            <span className="text-xs text-gray-400">시작일 미지정 — 일정관리에서 시작일을 입력하세요</span>
                          )}
                        </div>
                        {plan.total > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {plan.measurements.map(m => {
                              const done = completions.has(`${zone.id}_${m.num}`) || m.date <= todayMid;
                              return (
                                <span key={m.num}
                                  className={`text-[11px] px-1.5 py-1 rounded border ${done ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-gray-200 text-gray-600'}`}
                                  title={`${m.num}회차`}>
                                  <b className="text-gray-400 mr-1">{m.num}</b>{String(m.date.getFullYear()).slice(2)}/{m.date.getMonth() + 1}/{m.date.getDate()}({DOW[m.date.getDay()]})
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <div className="text-center py-10 text-sm text-gray-400">구역이 없습니다.</div>}
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
}
