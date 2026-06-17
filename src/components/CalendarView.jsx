import { useState, useEffect } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan } from '../lib/api';
import { parseISO, differenceInDays } from 'date-fns';

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

function buildGrid(year, month) {
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = Array(firstDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function CalendarView({ year: initYear, onYearChange }) {
  const today = new Date();
  const [year, setYear] = useState(initYear || today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState(null);

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
    ]).then(([cal, zns, mon, plan]) => {
      setCalibration(cal);
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setLoading(false);
    });
  }, [year, month]);

  function prevMonth() {
    if (month === 1) { const y = year - 1; setYear(y); onYearChange?.(y); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { const y = year + 1; setYear(y); onYearChange?.(y); setMonth(1); }
    else setMonth(m => m + 1);
  }

  // 교정 일정: 날짜별 그룹
  const calibByDay = {};
  calibration.forEach(c => {
    if (!c.next_calib_date) return;
    const d = parseISO(c.next_calib_date);
    if (d.getFullYear() === year && d.getMonth() + 1 === month) {
      const day = d.getDate();
      if (!calibByDay[day]) calibByDay[day] = [];
      calibByDay[day].push(c);
    }
  });

  // 이번달 모니터링
  const completedCount = zones.filter(z => monitoring[z.id]).length;
  const monRate = zones.length ? Math.round(completedCount / zones.length * 100) : 0;

  // AHU 이번달
  const ahuTasks = Object.entries(annualPlan)
    .filter(([key]) => {
      const parts = key.split('_');
      return parts[parts.length - 1] === String(month);
    })
    .map(([key, val]) => {
      const parts = key.split('_');
      parts.pop();
      return { ahuName: parts.join('_'), ...val };
    })
    .filter(t => t.planned);

  const grid = buildGrid(year, month);
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  const selectedEvents = selectedDay ? (calibByDay[selectedDay] || []) : [];

  function dDayColor(dateStr) {
    const d = differenceInDays(parseISO(dateStr), today);
    if (d < 0) return 'bg-red-100 text-red-700 border border-red-200';
    if (d <= 7) return 'bg-orange-100 text-orange-700 border border-orange-200';
    return 'bg-yellow-50 text-yellow-700 border border-yellow-200';
  }

  function dDayText(dateStr) {
    const d = differenceInDays(parseISO(dateStr), today);
    if (d < 0) return `만료 ${Math.abs(d)}일`;
    if (d === 0) return 'D-Day';
    return `D-${d}`;
  }

  return (
    <div className="p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">달력보기</h1>
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-2 py-1">
          <button
            onClick={prevMonth}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none"
          >
            ‹
          </button>
          <span className="text-base font-semibold text-gray-800 min-w-[96px] text-center">
            {year}년 {MONTH_KR[month - 1]}
          </span>
          <button
            onClick={nextMonth}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none"
          >
            ›
          </button>
        </div>
      </div>

      {/* 요약 바 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            monRate === 100 ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'
          }`}>
            {monRate}%
          </div>
          <div>
            <p className="text-xs text-gray-500">모니터링</p>
            <p className="text-sm font-semibold text-gray-700">{completedCount}/{zones.length} 구역</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            Object.keys(calibByDay).length > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'
          }`}>
            {Object.keys(calibByDay).length}
          </div>
          <div>
            <p className="text-xs text-gray-500">교정 예정일</p>
            <p className="text-sm font-semibold text-gray-700">이번달</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            ahuTasks.length > 0 ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-400'
          }`}>
            {ahuTasks.filter(t => t.done).length}/{ahuTasks.length}
          </div>
          <div>
            <p className="text-xs text-gray-500">AHU 계획</p>
            <p className="text-sm font-semibold text-gray-700">완료/예정</p>
          </div>
        </div>
      </div>

      <div className="flex gap-5">
        {/* 달력 */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* 요일 헤더 */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {DOW_LABELS.map((d, i) => (
              <div
                key={d}
                className={`py-2.5 text-center text-xs font-semibold ${
                  i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'
                }`}
              >
                {d}
              </div>
            ))}
          </div>

          {/* 날짜 그리드 */}
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {grid.map((day, idx) => {
                if (!day) {
                  return <div key={idx} className="h-24 bg-gray-50/50 border-r border-b border-gray-100 last:border-r-0" />;
                }
                const events = calibByDay[day] || [];
                const isToday = isCurrentMonth && day === todayDate;
                const isSelected = day === selectedDay;
                const dow = idx % 7;

                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                    className={`h-24 p-1.5 border-r border-b border-gray-100 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50' : isToday ? 'bg-blue-50/50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className={`text-xs font-semibold mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                      isToday
                        ? 'bg-blue-600 text-white'
                        : dow === 0 ? 'text-red-500'
                        : dow === 6 ? 'text-blue-500'
                        : 'text-gray-700'
                    }`}>
                      {day}
                    </div>
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      {events.slice(0, 3).map((c, i) => (
                        <div
                          key={i}
                          className={`text-xs px-1 py-0.5 rounded truncate ${dDayColor(c.next_calib_date)}`}
                          title={`${c.name} (${dDayText(c.next_calib_date)})`}
                        >
                          {c.name}
                        </div>
                      ))}
                      {events.length > 3 && (
                        <div className="text-xs text-gray-400 px-1">+{events.length - 3}건 더</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 범례 */}
          <div className="flex gap-4 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />
              만료됨
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-orange-100 border border-orange-200 inline-block" />
              7일 이내
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-yellow-50 border border-yellow-200 inline-block" />
              이번달 예정
            </div>
          </div>
        </div>

        {/* 사이드 패널 */}
        <div className="w-64 space-y-3 shrink-0">
          {/* 선택한 날의 교정 이벤트 */}
          {selectedDay && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-blue-600 text-white">
                <p className="text-xs text-blue-200">{year}년 {MONTH_KR[month - 1]}</p>
                <p className="text-lg font-bold">{selectedDay}일 교정 일정</p>
              </div>
              {selectedEvents.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-400">교정 일정 없음</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {selectedEvents.map(c => (
                    <div key={c.id} className="px-4 py-3">
                      <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">S/N: {c.sn || '-'}</p>
                      <p className={`text-xs font-bold mt-1 ${
                        differenceInDays(parseISO(c.next_calib_date), today) < 0 ? 'text-red-600' : 'text-orange-500'
                      }`}>
                        {dDayText(c.next_calib_date)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AHU 계획 */}
          {ahuTasks.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600">🔧 {MONTH_KR[month - 1]} AHU 계획</p>
              </div>
              <div className="divide-y divide-gray-50">
                {ahuTasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={`text-sm ${t.done ? 'text-green-500' : 'text-gray-300'}`}>
                      {t.done ? '✓' : '○'}
                    </span>
                    <span className={`text-sm flex-1 ${t.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                      {t.ahuName}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      t.done ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {t.done ? '완료' : '예정'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 이번달 미완료 구역 */}
          {zones.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-600">📋 모니터링 현황</p>
                <span className={`text-xs font-bold ${monRate === 100 ? 'text-green-600' : 'text-blue-600'}`}>{monRate}%</span>
              </div>
              <div className="px-4 py-3">
                <div className="w-full bg-gray-100 rounded-full h-2 mb-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full ${monRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
                    style={{ width: `${monRate}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500">{completedCount}/{zones.length} 구역 완료</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
