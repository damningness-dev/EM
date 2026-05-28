import { useState, useMemo } from 'react';
import { getMonitoringZones, getMonitoringData, getMonitoringKey, getYear } from '../utils/storage';
import { GRADE_TARGETS, GRADE_COLORS } from '../data/initialData';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function ZoneStatus() {
  const year = getYear();
  const zones = getMonitoringZones();
  const monData = getMonitoringData();
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');

  const filtered = useMemo(() => {
    let list = zones;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(z => z.name.toLowerCase().includes(q));
    }
    if (gradeFilter !== 'all') list = list.filter(z => z.grade === gradeFilter);
    return list;
  }, [zones, search, gradeFilter]);

  function getCount(zoneId, month) {
    const key = getMonitoringKey(year, month, zoneId);
    const entry = monData[key];
    return entry ? (parseInt(entry.count) || 0) : 0;
  }

  function getTotal(zone, month) {
    return GRADE_TARGETS[zone.grade] || 1;
  }

  function cellStyle(count, target) {
    if (count === 0) return 'bg-gray-50 text-gray-300';
    if (count >= target) return 'bg-green-100 text-green-700 font-semibold';
    return 'bg-blue-50 text-blue-600';
  }

  const currentMonth = new Date().getMonth() + 1;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold text-gray-800">{year}년 구역별 연간 현황</h1>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="구역명 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm"
        />
        <div className="flex gap-2 flex-wrap">
          {['all', 'P1', 'P2', 'P3', '유지관리'].map(g => (
            <button
              key={g}
              onClick={() => setGradeFilter(g)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
              {g === 'all' ? '전체' : g}
            </button>
          ))}
        </div>
      </div>

      {/* 범례 */}
      <div className="flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-100 rounded inline-block"></span> 완료</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-50 rounded inline-block"></span> 진행중</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-gray-50 border rounded inline-block"></span> 미시작</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-gray-500 font-medium whitespace-nowrap sticky left-0 bg-gray-50 z-10 border-r">구역명</th>
                <th className="text-center px-2 py-3 text-gray-500 font-medium border-r">등급</th>
                {MONTHS.map(m => (
                  <th key={m} className={`text-center px-2 py-3 font-medium ${m === currentMonth ? 'text-blue-600 bg-blue-50' : 'text-gray-500'}`}>
                    {m}월
                  </th>
                ))}
                <th className="text-center px-3 py-3 text-gray-500 font-medium border-l">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(zone => {
                let totalCount = 0, totalTarget = 0;
                return (
                  <tr key={zone.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-white border-r">{zone.name}</td>
                    <td className="px-2 py-2 text-center border-r">
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                    </td>
                    {MONTHS.map(m => {
                      const count = getCount(zone.id, m);
                      const target = getTotal(zone, m);
                      totalCount += count;
                      totalTarget += target;
                      return (
                        <td key={m} className={`px-2 py-2 text-center ${cellStyle(count, target)} ${m === currentMonth ? 'border border-blue-200' : ''}`}>
                          {count > 0 ? `${count}/${target}` : '-'}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center border-l font-semibold text-gray-600">
                      {totalCount}/{totalTarget}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
