import { useState, useEffect, useMemo } from 'react';
import { format, differenceInDays } from 'date-fns';
import { fetchZones, fetchAllMonitoringData } from '../lib/api';
import { GRADE_TARGETS, GRADE_COLORS } from '../data/initialData';
import { calcMeasurements } from '../lib/schedule';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const GANTT_COLORS = {
  P1: 'bg-red-400',
  P2: 'bg-orange-400',
  P3: 'bg-blue-400',
};

export default function ZoneStatus({ year, onYearChange }) {
  const [zones, setZones] = useState([]);
  const [monData, setMonData] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');

  useEffect(() => {
    Promise.all([fetchZones(), fetchAllMonitoringData(year)]).then(([z, m]) => {
      setZones(z);
      setMonData(m);
      setLoading(false);
    });
  }, [year]);

  const filtered = useMemo(() => {
    let list = zones;
    if (search) list = list.filter(z => z.name.toLowerCase().includes(search.toLowerCase()));
    if (gradeFilter !== 'all') list = list.filter(z => z.grade === gradeFilter);
    return list;
  }, [zones, search, gradeFilter]);

  function getCount(zoneId, month) {
    const entry = monData[`${zoneId}_${month}`];
    return entry ? (parseInt(entry.count) || 0) : 0;
  }

  function cellStyle(count, target) {
    if (count === 0) return 'bg-gray-50 text-gray-300';
    if (count >= target) return 'bg-green-100 text-green-700 font-semibold';
    return 'bg-blue-50 text-blue-600';
  }

  const currentMonth = new Date().getMonth() + 1;
  const today = new Date();
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const yearDays = differenceInDays(yearEnd, yearStart) + 1;

  function getBarInfo(zone) {
    const ms = calcMeasurements(zone);
    if (!ms.length || !zone.schedule_start) return null;
    const startDate = new Date(zone.schedule_start + 'T00:00:00');
    const endDate = ms[ms.length - 1].baseDate;
    const startDay = differenceInDays(startDate, yearStart);
    const endDay = differenceInDays(endDate, yearStart);
    const clippedStart = Math.max(0, startDay);
    const clippedEnd = Math.min(yearDays - 1, endDay);
    if (clippedStart > yearDays - 1 || clippedEnd < 0) return null;
    return {
      leftPct: (clippedStart / yearDays) * 100,
      widthPct: ((clippedEnd - clippedStart + 1) / yearDays) * 100,
      startLabel: format(startDate, 'MM.dd'),
      endLabel: format(endDate, 'MM.dd'),
    };
  }

  const ganttZones = filtered.filter(z => z.schedule_start && ['P1', 'P2', 'P3'].includes(z.grade));
  const todayPct = year === today.getFullYear()
    ? Math.min(100, Math.max(0, (differenceInDays(today, yearStart) / yearDays) * 100))
    : null;

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">{year}년 구역별 연간 현황</h1>
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

      <div className="flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-100 rounded inline-block"></span> 완료</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-50 border rounded inline-block"></span> 진행중</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-gray-50 border rounded inline-block"></span> 미시작</span>
      </div>

      {/* Monthly count table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-gray-500 font-medium whitespace-nowrap sticky left-0 bg-gray-50 z-10 border-r">구역명</th>
                <th className="text-center px-2 py-3 text-gray-500 font-medium border-r">등급</th>
                {MONTHS.map(m => (
                  <th key={m} className={`text-center px-2 py-3 font-medium ${m === currentMonth ? 'text-blue-600 bg-blue-50' : 'text-gray-500'}`}>{m}월</th>
                ))}
                <th className="text-center px-3 py-3 text-gray-500 font-medium border-l">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(zone => {
                let totalCount = 0, totalTarget = 0;
                const target = GRADE_TARGETS[zone.grade] || 1;
                return (
                  <tr key={zone.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-white border-r">{zone.name}</td>
                    <td className="px-2 py-2 text-center border-r">
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                    </td>
                    {MONTHS.map(m => {
                      const count = getCount(zone.id, m);
                      totalCount += count;
                      totalTarget += target;
                      return (
                        <td key={m} className={`px-2 py-2 text-center ${cellStyle(count, target)} ${m === currentMonth ? 'border border-blue-200' : ''}`}>
                          {count > 0 ? `${count}/${target}` : '-'}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center border-l font-semibold text-gray-600">{totalCount}/{totalTarget}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gantt chart */}
      {ganttZones.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">📊 측정 일정 간트 차트</h2>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-red-400 inline-block" />P1</span>
              <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-orange-400 inline-block" />P2</span>
              <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-blue-400 inline-block" />P3</span>
              {todayPct !== null && <span className="flex items-center gap-1"><span className="w-0.5 h-3 bg-red-500 inline-block" />오늘</span>}
            </div>
          </div>
          <div className="p-4 overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Month header */}
              <div className="flex mb-1">
                <div className="w-44 shrink-0" />
                <div className="flex-1 flex">
                  {MONTHS.map(m => (
                    <div
                      key={m}
                      className={`flex-1 text-center text-xs py-1 border-l border-gray-100 ${m === currentMonth ? 'text-blue-600 font-semibold' : 'text-gray-400'}`}
                    >{m}월</div>
                  ))}
                </div>
              </div>
              {/* Zone rows */}
              {ganttZones.map(zone => {
                const bar = getBarInfo(zone);
                return (
                  <div key={zone.id} className="flex items-center mb-2">
                    <div className="w-44 shrink-0 pr-3 flex items-center gap-1.5">
                      <span className={`text-xs font-semibold px-1 py-0.5 rounded shrink-0 ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                      <span className="text-xs text-gray-600 truncate" title={zone.name}>{zone.name}</span>
                    </div>
                    <div className="flex-1 relative h-7 bg-gray-50 rounded border border-gray-100">
                      {/* Month dividers */}
                      {MONTHS.map(m => (
                        <div
                          key={m}
                          className={`absolute inset-y-0 border-l ${m === currentMonth ? 'border-blue-200' : 'border-gray-100'}`}
                          style={{ left: `${((m - 1) / 12) * 100}%` }}
                        />
                      ))}
                      {/* Today marker */}
                      {todayPct !== null && (
                        <div
                          className="absolute inset-y-0 w-0.5 bg-red-400 z-10 opacity-70"
                          style={{ left: `${todayPct}%` }}
                        />
                      )}
                      {/* Schedule bar */}
                      {bar && (
                        <div
                          className={`absolute top-1 bottom-1 ${GANTT_COLORS[zone.grade] || 'bg-gray-400'} rounded flex items-center justify-center overflow-hidden`}
                          style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%`, minWidth: '2px' }}
                          title={`${zone.name}  ${bar.startLabel}~${bar.endLabel}`}
                        >
                          {bar.widthPct > 12 && (
                            <span className="text-white text-xs font-medium whitespace-nowrap px-1 truncate">
                              {bar.startLabel}~{bar.endLabel}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
}
