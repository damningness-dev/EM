import { useEffect, useState } from 'react';
import { calcDDay, getDDayLabel, getDDayColor } from '../utils/dateUtils';
import { effectiveCalib } from '../utils/calibUtils';
import { fetchCalibration, fetchZones, fetchAnnualPlan, fetchHolidays, fetchBlockedDates, fetchScheduleConfig, fetchCompletions } from '../lib/api';
import { GRADE_COLORS } from '../data/initialData';
import { buildHolidayMap, setScheduleConfig, calcEndDate } from '../lib/schedule';
import { mergeScheduleConfig, buildZoneOrderRank, buildScheduleByDate, buildMonitorRows, isWaterZone } from '../lib/monitoringDay';

import useDataVersion from '../hooks/useDataVersion';
export default function Dashboard({ year, onJumpToCalibration }) {
  const dataVersion = useDataVersion(); // 공유 동기화 시 화면 자동 최신화
  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  // 월별 모니터링 일정(달력)과 같은 기준: 측정 일정(회차)과 완료 표시(더블클릭)로 진행률을 센다
  const [selMonth, setSelMonth] = useState(() => (year === new Date().getFullYear() ? new Date().getMonth() + 1 : 1)); // 진행률에서 고른 월
  const [spans, setSpans] = useState([]); // 구역별 일정의 시작일·종료 예정일 [{ zone, start, end }]
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
      // 구역마다 일정이 시작되는 날(schedule_start)과 끝나는 예정일(마지막 측정일) — 달력과 같은 공휴일 기준으로 계산
      const fmtD = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
      setSpans(zns.filter(zone => zone.schedule_start).map(zone => { let end = ''; try { end = fmtD(calcEndDate(zone, avoid)); } catch { /* 계산할 수 없으면 종료일 없음 */ } return { zone, start: zone.schedule_start, end }; }));
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
              <div key={month} onClick={() => setSelMonth(month)} role="button" title="눌러서 이 달에 시작·종료되는 일정 보기"
                className={`text-center rounded-lg p-3 border cursor-pointer transition-colors ${month === selMonth ? 'ring-2 ring-blue-500 ' : ''}${month === currentMonth ? 'border-blue-400 bg-blue-50' : 'border-gray-100 hover:bg-gray-50'}`}>
                <div className="text-xs text-gray-500 mb-1">{month}월</div>
                <div className={`text-lg font-bold ${pct === 100 ? 'text-green-600' : pct > 0 ? 'text-blue-600' : 'text-gray-300'}`}>{pct}%</div>
                <div className="text-xs text-gray-400">{done}/{total}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 고른 월에 시작되는 일정과 끝나는 일정(구역별 일정의 시작일·종료 예정일) */}
      {(() => {
        const prefix = `${year}-${String(selMonth).padStart(2, '0')}-`;
        const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
        const dday = (ds) => {
          const diff = Math.round((new Date(ds + 'T00:00:00') - todayMid) / 86400000);
          return { text: diff === 0 ? 'D-DAY' : diff > 0 ? `D-${diff}` : `D+${-diff}`, cls: diff === 0 ? 'text-red-600 bg-red-50 border-red-200' : diff < 0 ? 'text-gray-400 bg-gray-50 border-gray-200' : diff <= 7 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-500 bg-white border-gray-200' };
        };
        const starts = spans.filter(x => x.start.startsWith(prefix)).sort((p, q) => p.start.localeCompare(q.start) || p.zone.name.localeCompare(q.zone.name));
        const ends = spans.filter(x => x.end && x.end.startsWith(prefix)).sort((p, q) => p.end.localeCompare(q.end) || p.zone.name.localeCompare(q.zone.name));
        const col = (title, icon, list, key, tone) => (
          <div className="rounded-lg border border-gray-100 overflow-hidden">
            <div className={`px-4 py-2.5 flex items-center gap-2 ${tone}`}>
              <span>{icon}</span><span className="text-sm font-semibold">{title}</span><span className="ml-auto text-xs font-semibold">{list.length}건</span>
            </div>
            {list.length === 0 ? <p className="px-4 py-6 text-sm text-gray-300">해당하는 일정이 없습니다.</p> : (
              <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
                {list.map(x => { const d = dday(x[key]); return (
                  <div key={`${x.zone.id}${key}`} className="px-4 py-2 flex items-center gap-2 text-sm">
                    {x.zone.grade && <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${GRADE_COLORS[x.zone.grade] || 'bg-gray-100 text-gray-600'}`}>{x.zone.grade}</span>}
                    <span className="shrink-0 text-[11px] text-gray-400">{x.zone.category}</span>
                    <span className="min-w-0 truncate text-gray-800" title={x.zone.name}>{x.zone.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-gray-600 tabular-nums">{x[key].slice(5, 7)}/{x[key].slice(8, 10)}</span>
                    <span className={`shrink-0 text-[11px] leading-none font-bold px-1.5 py-1 rounded border ${d.cls}`}>{d.text}</span>
                  </div>
                ); })}
              </div>
            )}
          </div>
        );
        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <h2 className="font-semibold text-gray-800">{year}년 {selMonth}월 시작·종료 일정</h2>
              <span className="text-xs text-gray-400">위 월별 진행률에서 월을 눌러 바꿉니다 · D-DAY는 오늘 기준</span>
            </div>
            <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {col('시작하는 일정', '🟢', starts, 'start', 'bg-green-50 text-green-700')}
              {col('끝나는 일정', '🔴', ends, 'end', 'bg-red-50 text-red-700')}
            </div>
          </div>
        );
      })()}
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
