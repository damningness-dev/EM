import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { format, differenceInDays } from 'date-fns';
import { fetchZones } from '../lib/api';
import { calcMeasurements } from '../lib/schedule';

const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];
const GRADE_ORDER = ['P1','P2','P3','유지관리'];
const GANTT_COLORS = {
  P1:       'bg-red-400',
  P2:       'bg-green-400',
  P3:       'bg-blue-400',
  '유지관리': 'bg-orange-400',
};

const BAR_H = 18;          // 막대 높이
const PAD_V = 5;           // 트랙 상하 여백
const ROW_H = PAD_V * 2 + BAR_H;
const CHAR_PX = 5.6;       // text-[10px] 숫자 한 글자 대략 폭
const LABEL_PAD = 10;      // 라벨 좌우 여백 버퍼

export default function ZoneGantt({ year, onYearChange }) {
  const [zones,   setZones]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');
  const [showGrades, setShowGrades] = useState(new Set(GRADE_ORDER));
  const trackRef = useRef(null);
  const [trackW, setTrackW] = useState(0);

  useEffect(() => {
    fetchZones().then(z => { setZones(z); setLoading(false); });
  }, []);

  // 트랙(막대 영역) 실제 픽셀 폭 측정 → 라벨이 막대 안에 들어가는지 판단
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const today    = new Date();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31);
  const yearDays  = differenceInDays(yearEnd, yearStart) + 1;
  const currentMonth = today.getMonth() + 1;
  const todayPct = year === today.getFullYear()
    ? Math.min(100, Math.max(0, (differenceInDays(today, yearStart) / yearDays) * 100))
    : null;

  function getBarInfo(zone) {
    const ms = calcMeasurements(zone);
    if (!ms.length || !zone.schedule_start) return null;
    const startDate = new Date(zone.schedule_start + 'T00:00:00');
    const endDate   = ms[ms.length - 1].baseDate;
    const clippedStart = Math.max(0, differenceInDays(startDate, yearStart));
    const clippedEnd   = Math.min(yearDays - 1, differenceInDays(endDate, yearStart));
    if (clippedStart > yearDays - 1 || clippedEnd < 0) return null;
    return {
      leftPct:  (clippedStart / yearDays) * 100,
      widthPct: ((clippedEnd - clippedStart + 1) / yearDays) * 100,
      startLabel: format(startDate, 'yyyy.MM.dd'),
      endLabel:   format(endDate,   'yyyy.MM.dd'),
    };
  }

  // 구역명으로 그룹화, sort_order 기준 정렬
  const groups = useMemo(() => {
    const map = new Map();
    [...zones]
      .sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9))
      .forEach(z => {
        if (!map.has(z.name)) map.set(z.name, { name: z.name, zones: [] });
        map.get(z.name).zones.push(z);
      });
    map.forEach(g => {
      g.zones.sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade));
    });
    const arr = [...map.values()];
    if (!search) return arr;
    return arr.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
  }, [zones, search]);

  function toggleGrade(g) {
    setShowGrades(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  }

  if (loading) return <Spinner />;

  return (
    <div className="p-6 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">{year}년 측정 일정 간트 차트</h1>
        <div className="flex gap-1">
          <button onClick={() => onYearChange(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
          <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
          <button onClick={() => onYearChange(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="구역명 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <div className="flex gap-1.5 flex-wrap">
          {GRADE_ORDER.map(g => (
            <button
              key={g}
              onClick={() => toggleGrade(g)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                showGrades.has(g) ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-400 hover:bg-gray-50'
              }`}
            >{g}</button>
          ))}
        </div>
        {/* 범례 */}
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {GRADE_ORDER.map(g => (
            <span key={g} className="flex items-center gap-1">
              <span className={`w-4 h-2.5 rounded inline-block ${GANTT_COLORS[g]}`} />{g}
            </span>
          ))}
          {todayPct !== null && (
            <span className="flex items-center gap-1">
              <span className="w-0.5 h-3.5 bg-red-500 inline-block rounded" />오늘
            </span>
          )}
        </div>
      </div>

      {/* 간트 차트 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 overflow-x-auto">
          <div className="min-w-[640px]">
            {/* 월 헤더 */}
            <div className="flex mb-2">
              <div className="w-52 shrink-0" />
              <div ref={trackRef} className="flex-1 flex border-l border-gray-200">
                {MONTHS.map(m => (
                  <div
                    key={m}
                    className={`flex-1 text-center text-xs py-1 border-r border-gray-100 ${
                      m === currentMonth ? 'text-blue-600 font-semibold bg-blue-50/50' : 'text-gray-400'
                    }`}
                  >{m}월</div>
                ))}
              </div>
            </div>

            {/* 구역 행 */}
            {groups.map(group => {
              const visible = group.zones.filter(z => showGrades.has(z.grade));
              if (!visible.length) return null;
              return (
                <div key={group.name} className="flex items-stretch mb-1">
                  {/* 구역명 */}
                  <div className="w-52 shrink-0 pr-3 flex items-center py-1">
                    <span className="text-xs font-medium text-gray-700 truncate" title={group.name}>
                      {group.name}
                    </span>
                  </div>

                  {/* 바 트랙 — 같은 구역의 모든 등급을 한 행에 표시 */}
                  <div
                    className="flex-1 relative bg-gray-50 rounded border border-gray-100"
                    style={{ height: ROW_H }}
                  >
                    {/* 월 구분선 */}
                    {MONTHS.map(m => (
                      <div
                        key={m}
                        className={`absolute inset-y-0 border-l ${m === currentMonth ? 'border-blue-200' : 'border-gray-100'}`}
                        style={{ left: `${((m - 1) / 12) * 100}%` }}
                      />
                    ))}
                    {/* 오늘 마커 */}
                    {todayPct !== null && (
                      <div
                        className="absolute inset-y-0 w-0.5 bg-red-400 z-10 opacity-60"
                        style={{ left: `${todayPct}%` }}
                      />
                    )}
                    {/* 등급별 바 (단일 레인) */}
                    {visible.map((zone) => {
                      const bar = getBarInfo(zone);
                      if (!bar) return null;
                      const label = `${bar.startLabel}~${bar.endLabel}`;
                      const labelPx = label.length * CHAR_PX + LABEL_PAD;
                      const barPx   = (bar.widthPct / 100) * trackW;
                      const leftPx  = (bar.leftPct / 100) * trackW;
                      const rightPx = trackW - leftPx - barPx;
                      // 막대 안에 라벨이 들어가면 안쪽, 아니면 바깥(여유 있는 쪽, 왼쪽 우선)
                      const side = barPx >= labelPx ? 'inside'
                        : (leftPx >= labelPx || leftPx >= rightPx) ? 'left' : 'right';
                      const title = `${zone.name} (${zone.grade})  ${bar.startLabel} ~ ${bar.endLabel}`;
                      return (
                        <div key={zone.id}>
                          <div
                            className={`absolute ${GANTT_COLORS[zone.grade] || 'bg-gray-400'} rounded flex items-center overflow-hidden`}
                            style={{ top: PAD_V, height: BAR_H, left: `${bar.leftPct}%`, width: `${bar.widthPct}%`, minWidth: 2 }}
                            title={title}
                          >
                            {side === 'inside' && (
                              <span className="text-white text-[10px] font-medium whitespace-nowrap px-1 truncate">
                                {label}
                              </span>
                            )}
                          </div>
                          {side === 'left' && (
                            <span
                              className="absolute flex items-center justify-end text-[10px] font-medium text-gray-600 whitespace-nowrap pr-1 z-20"
                              style={{ top: PAD_V, height: BAR_H, right: `${100 - bar.leftPct}%` }}
                              title={title}
                            >{label}</span>
                          )}
                          {side === 'right' && (
                            <span
                              className="absolute flex items-center text-[10px] font-medium text-gray-600 whitespace-nowrap pl-1 z-20"
                              style={{ top: PAD_V, height: BAR_H, left: `${bar.leftPct + bar.widthPct}%` }}
                              title={title}
                            >{label}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {groups.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-10">표시할 일정이 없습니다.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
