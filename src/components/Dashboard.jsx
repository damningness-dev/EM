import { useEffect, useState } from 'react';
import { calcDDay, getDDayLabel, getDDayColor } from '../utils/dateUtils';
import { effectiveCalib } from '../utils/calibUtils';
import { fetchCalibration, fetchZones, fetchAnnualPlan, fetchHolidays, fetchBlockedDates, fetchScheduleConfig, fetchCompletions } from '../lib/api';
import { GRADE_COLORS } from '../data/initialData';
import { buildHolidayMap, setScheduleConfig } from '../lib/schedule';
import { mergeScheduleConfig, buildZoneOrderRank, buildScheduleByDate, buildMonitorRows, isWaterZone } from '../lib/monitoringDay';

import useDataVersion from '../hooks/useDataVersion';
export default function Dashboard({ year, onJumpToCalibration }) {
  const dataVersion = useDataVersion(); // 공유 동기화 시 화면 자동 최신화
  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  // 월별 모니터링 일정(달력)과 같은 기준: 측정 일정(회차)과 완료 표시(더블클릭)로 진행률을 센다
  const [monRows, setMonRows] = useState({}); // { 1: [{ zone, measurement, done }], ... 12 }
  const [plan, setPlan] = useState({});
  const [loading, setLoading] = useState(true);

  const currentMonth = new Date().getMonth() + 1;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchAnnualPlan(year),
      fetchHolidays().catch(() => []),
      fetchBlockedDates().catch(() => []),
      fetchScheduleConfig().catch(() => null),
      fetchCompletions().catch(() => []),
    ]).then(([c, z, p, holidayDefs, blocked, cfg, comps]) => {
      setScheduleConfig(mergeScheduleConfig(cfg)); // 일정 계산 함수가 읽는 주기 설정
      // 용수 구역은 '용수모니터링 일정' 메뉴로 옮겨져 월별 모니터링 진행률에서는 뺀다
      const zns = (z || []).map(zone => zone.category === '청정등급' ? { ...zone, category: '공조' } : zone).filter(zone => !isWaterZone(zone));
      const avoid = { ...buildHolidayMap(holidayDefs || [], year - 1, year + 1) };
      (blocked || []).forEach(d => { if (!avoid[d]) avoid[d] = '일정비우기'; });
      const rank = buildZoneOrderRank(zns);
      const byDate = buildScheduleByDate(zns, avoid, rank);
      const done = new Set((comps || []).map(x => `${x.zoneId}_${x.num}`));
      const rows = {};
      for (let m = 1; m <= 12; m++) rows[m] = buildMonitorRows(byDate, rank, year, m).filter(r => !r.carried).map(r => ({ ...r, done: done.has(`${r.zone.id}_${r.measurement.num}`) }));
      setCalibration(c);
      setZones(zns);
      setMonRows(rows);
      setPlan(p);
      setLoading(false);
    });
  }, [year, dataVersion]);

  const urgentCalib = calibration
    .map(c => ({ ...c, eff: effectiveCalib(c) }))
    .filter(c => c.eff.next_calib_date && c.eff.next_calib_date !== '미사용')
    .map(c => ({ ...c, dday: calcDDay(c.eff.next_calib_date) }))
    .filter(c => c.dday !== null && c.dday <= 60)
    .sort((a, b) => a.dday - b.dday);

  function getMonthStat(month) {
    const rows = monRows[month] || [];
    const total = rows.length, done = rows.filter(r => r.done).length;
    return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  const ahuDone = (() => {
    let total = 0, done = 0;
    Object.values(plan).forEach(row => {
      if (row.planned) { total++; if (row.done) done++; }
    });
    return { total, done };
  })();

  const currentStat = getMonthStat(currentMonth);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">{year}년 환경 모니터링 대시보드</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="이번 달 모니터링" value={`${currentStat.pct}%`} sub={`${currentMonth}월 • ${currentStat.done}/${currentStat.total}`} color="bg-blue-50 border-blue-200" valueColor="text-blue-700" />
        <StatCard title="교정 만료 임박" value={urgentCalib.length} sub="60일 이내" color={urgentCalib.length > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"} valueColor={urgentCalib.length > 0 ? "text-red-600" : "text-green-600"} />
        <StatCard title="AHU 연간계획" value={`${ahuDone.done}/${ahuDone.total}`} sub="완료/계획" color="bg-purple-50 border-purple-200" valueColor="text-purple-700" />
        <StatCard title="모니터링 구역" value={zones.length} sub="등록된 구역 수" color="bg-gray-50 border-gray-200" valueColor="text-gray-700" />
      </div>

      {urgentCalib.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <span className="text-orange-500">⚠️</span>
            <h2 className="font-semibold text-gray-800">교정 만료 임박 ({urgentCalib.length}건)</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {urgentCalib.map(item => (
              <div key={item.id} onClick={() => onJumpToCalibration?.(item.id)} role="button"
                title="누르면 교정 관리에서 이 교정건으로 이동합니다"
                className="px-5 py-3 flex items-center justify-between hover:bg-orange-50 cursor-pointer transition-colors">
                <div>
                  <span className="font-medium text-gray-800">{item.no}</span>
                  {item.name && <span className="ml-2 text-sm text-gray-500">{item.name}</span>}
                  <span className="ml-2 text-xs text-gray-400">S/N: {item.sn}</span>
                </div>
                <div className="text-right">
                  <div className={`text-sm font-bold ${getDDayColor(item.dday)}`}>{getDDayLabel(item.dday)}</div>
                  <div className="text-xs text-gray-400">{item.eff.next_calib_date}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">{year}년 월별 모니터링 진행률</h2>
        </div>
        <div className="p-5 grid grid-cols-6 lg:grid-cols-12 gap-3">
          {Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
            const { pct, done, total } = getMonthStat(month);
            return (
              <div key={month} className={`text-center rounded-lg p-3 border ${month === currentMonth ? 'border-blue-400 bg-blue-50' : 'border-gray-100'}`}>
                <div className="text-xs text-gray-500 mb-1">{month}월</div>
                <div className={`text-lg font-bold ${pct === 100 ? 'text-green-600' : pct > 0 ? 'text-blue-600' : 'text-gray-300'}`}>{pct}%</div>
                <div className="text-xs text-gray-400">{done}/{total}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">등급별 구역 현황 ({currentMonth}월)</h2>
        </div>
        <div className="p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
          {['P1', 'P2', 'P3', '유지관리'].map(grade => {
            const gradeRows = (monRows[currentMonth] || []).filter(r => r.zone.grade === grade);
            const gradeZones = [...new Set(gradeRows.map(r => r.zone.id))];
            const done = gradeRows.filter(r => r.done).length, total = gradeRows.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div key={grade} className="rounded-lg border border-gray-100 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${GRADE_COLORS[grade]}`}>{grade}</span>
                  <span className="text-sm text-gray-500">{gradeZones.length}구역</span>
                </div>
                <div className="text-2xl font-bold text-gray-700">{pct}%</div>
                <div className="text-xs text-gray-400">{done}/{total} 완료</div>
                <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, sub, color, valueColor }) {
  return (
    <div className={`rounded-xl border p-5 ${color}`}>
      <div className="text-sm text-gray-500 mb-1">{title}</div>
      <div className={`text-3xl font-bold ${valueColor}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1">{sub}</div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
