import { useEffect, useState } from 'react';
import { calcDDay, getDDayLabel, getDDayColor } from '../utils/dateUtils';
import { effectiveCalib } from '../utils/calibUtils';
import { fetchCalibration, fetchZones, fetchAllMonitoringData, fetchAnnualPlan } from '../lib/api';
import { GRADE_TARGETS, GRADE_COLORS } from '../data/initialData';

export default function Dashboard({ year }) {
  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monData, setMonData] = useState({});
  const [plan, setPlan] = useState({});
  const [loading, setLoading] = useState(true);

  const currentMonth = new Date().getMonth() + 1;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchAllMonitoringData(year),
      fetchAnnualPlan(year),
    ]).then(([c, z, m, p]) => {
      setCalibration(c);
      setZones(z);
      setMonData(m);
      setPlan(p);
      setLoading(false);
    });
  }, [year]);

  const urgentCalib = calibration
    .map(c => ({ ...c, eff: effectiveCalib(c) }))
    .filter(c => c.eff.next_calib_date && c.eff.next_calib_date !== '미사용')
    .map(c => ({ ...c, dday: calcDDay(c.eff.next_calib_date) }))
    .filter(c => c.dday !== null && c.dday <= 60)
    .sort((a, b) => a.dday - b.dday);

  function getMonthStat(month) {
    let total = 0, done = 0;
    zones.forEach(zone => {
      const target = GRADE_TARGETS[zone.grade] || 1;
      total += target;
      const entry = monData[`${zone.id}_${month}`];
      if (entry) done += Math.min(entry.count || 0, target);
    });
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
              <div key={item.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
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
            const gradeZones = zones.filter(z => z.grade === grade);
            const target = GRADE_TARGETS[grade] || 1;
            let done = 0, total = gradeZones.length * target;
            gradeZones.forEach(zone => {
              const entry = monData[`${zone.id}_${currentMonth}`];
              if (entry) done += Math.min(entry.count || 0, target);
            });
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
