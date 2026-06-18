import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, upsertZone } from '../lib/api';
import { parseISO, differenceInDays, format } from 'date-fns';
import { calcMeasurements, calcEndDate, totalCount, getDragBounds } from '../lib/schedule';
import { GRADE_COLORS } from '../data/initialData';

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const TYPE_COLORS = {
  daily:    'bg-red-100 text-red-700 border border-red-200',
  weekly:   'bg-blue-100 text-blue-700 border border-blue-200',
  biweekly: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  monthly:  'bg-violet-100 text-violet-700 border border-violet-200',
};

const TYPE_LABEL = { daily: '일1회', weekly: '주1회', biweekly: '격주', monthly: '월1회' };

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
  const [showSettings, setShowSettings] = useState(false);
  const [dragOverDay, setDragOverDay] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

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

  // Calibration events by day
  const calibByDay = {};
  calibration.forEach(c => {
    if (!c.next_calib_date) return;
    try {
      const d = parseISO(c.next_calib_date);
      if (d.getFullYear() === year && d.getMonth() + 1 === month) {
        const day = d.getDate();
        if (!calibByDay[day]) calibByDay[day] = [];
        calibByDay[day].push(c);
      }
    } catch {}
  });

  // Schedule events by day
  const scheduleByDay = useMemo(() => {
    const map = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      calcMeasurements(zone).forEach(m => {
        if (m.date.getFullYear() === year && m.date.getMonth() + 1 === month) {
          const day = m.date.getDate();
          if (!map[day]) map[day] = [];
          map[day].push({ zone, measurement: m });
        }
      });
    });
    return map;
  }, [zones, year, month]);

  // Monitoring stats
  const completedCount = zones.filter(z => monitoring[z.id]).length;
  const monRate = zones.length ? Math.round(completedCount / zones.length * 100) : 0;

  // AHU tasks this month
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

  const totalMonthSchedule = Object.values(scheduleByDay).reduce((sum, arr) => sum + arr.length, 0);
  const scheduledZonesCount = zones.filter(z => z.schedule_start && ['P1','P2','P3'].includes(z.grade)).length;

  const grid = buildGrid(year, month);
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  const selectedCalibEvents = selectedDay ? (calibByDay[selectedDay] || []) : [];
  const selectedScheduleEvents = selectedDay ? (scheduleByDay[selectedDay] || []) : [];

  function dDayColor(dateStr) {
    try {
      const d = differenceInDays(parseISO(dateStr), today);
      if (d < 0) return 'bg-red-100 text-red-700 border border-red-200';
      if (d <= 7) return 'bg-orange-100 text-orange-700 border border-orange-200';
      return 'bg-yellow-50 text-yellow-700 border border-yellow-200';
    } catch { return 'bg-gray-100 text-gray-500'; }
  }

  function dDayText(dateStr) {
    try {
      const d = differenceInDays(parseISO(dateStr), today);
      if (d < 0) return `만료 ${Math.abs(d)}일`;
      if (d === 0) return 'D-Day';
      return `D-${d}`;
    } catch { return ''; }
  }

  function showError(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function handleSetZoneStart(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  async function handleDropOnDay(day, dragData) {
    const zone = zones.find(z => z.id === dragData.zoneId);
    if (!zone) return;

    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    const newDateStr = `${year}-${m}-${d}`;

    if (newDateStr < dragData.minDateStr || newDateStr > dragData.maxDateStr) {
      const typeMsg = dragData.type === 'weekly' ? '해당 주간 내'
        : dragData.type === 'biweekly' ? '해당 주간 내'
        : dragData.type === 'monthly' ? '해당 월 내'
        : '동일 날짜';
      showError(`이동 불가: ${typeMsg}에서만 일정을 변경할 수 있습니다. (${dragData.minDateStr} ~ ${dragData.maxDateStr})`);
      return;
    }

    const updated = {
      ...zone,
      schedule_overrides: {
        ...(zone.schedule_overrides || {}),
        [String(dragData.num)]: newDateStr,
      },
    };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === dragData.zoneId ? updated : z));
  }

  return (
    <div className="p-6 space-y-5">

      {/* Error toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[200] bg-red-500 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 max-w-sm">
          <span className="text-base shrink-0 mt-0.5">⚠</span>
          <span className="text-sm font-medium flex-1 leading-snug">{toast}</span>
          <button onClick={() => setToast(null)} className="text-red-200 hover:text-white text-lg leading-none shrink-0">✕</button>
        </div>
      )}

      {/* Schedule settings drawer */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/30" onClick={() => setShowSettings(false)} />
          <div className="w-[480px] h-full bg-white shadow-2xl border-l border-gray-200 flex flex-col">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">모니터링 일정 설정</h2>
                <p className="text-xs text-gray-400 mt-0.5">{scheduledZonesCount}개 구역 설정됨 · 시작일 입력 시 일정 자동 계산</p>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-lg leading-none"
              >✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {['공조', '압축공기', '질소가스'].map(cat => {
                const catZones = zones
                  .filter(z => z.category === cat && ['P1', 'P2', 'P3'].includes(z.grade))
                  .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                if (!catZones.length) return null;
                return (
                  <div key={cat}>
                    <div className="px-5 py-2 bg-gray-50 border-b border-gray-100 sticky top-0 z-10">
                      <span className="text-xs font-bold text-gray-500">{cat}</span>
                      <span className="ml-2 text-xs text-gray-400">{catZones.length}개 구역</span>
                    </div>
                    {catZones.map(zone => {
                      const endDate = calcEndDate(zone);
                      const count = totalCount(zone);
                      const syncCandidates = zones.filter(z =>
                        z.id !== zone.id && z.schedule_start && ['P1','P2','P3'].includes(z.grade)
                      );
                      return (
                        <div key={zone.id} className="px-5 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors">
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>
                                  {zone.grade}
                                </span>
                                <span className="text-sm text-gray-700 truncate">{zone.name}</span>
                              </div>
                              <p className="text-xs text-gray-400">{count}회 측정</p>
                              {zone.schedule_start && endDate && (
                                <p className="text-xs text-blue-600 mt-0.5">
                                  종료: {format(endDate, 'yyyy.MM.dd')}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 flex flex-col gap-1.5 items-end">
                              <input
                                type="date"
                                value={zone.schedule_start || ''}
                                onChange={(e) => handleSetZoneStart(zone.id, e.target.value)}
                                className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              {syncCandidates.length > 0 && (
                                <select
                                  defaultValue=""
                                  onChange={(e) => {
                                    const src = zones.find(z => String(z.id) === e.target.value);
                                    if (src?.schedule_start) handleSetZoneStart(zone.id, src.schedule_start);
                                    e.target.value = '';
                                  }}
                                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[148px]"
                                >
                                  <option value="">같이가기...</option>
                                  {['공조','압축공기','질소가스'].map(c => {
                                    const opts = syncCandidates.filter(z => z.category === c);
                                    if (!opts.length) return null;
                                    return (
                                      <optgroup key={c} label={c}>
                                        {opts.map(z => (
                                          <option key={z.id} value={String(z.id)}>
                                            {z.name.length > 10 ? z.name.slice(0,10)+'…' : z.name}[{z.grade}] {z.schedule_start}
                                          </option>
                                        ))}
                                      </optgroup>
                                    );
                                  })}
                                </select>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">달력보기</h1>
          {totalMonthSchedule > 0 && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
              이번달 {totalMonthSchedule}건 측정 예정
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            ⚙ 일정 설정
          </button>
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-2 py-1">
            <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none">‹</button>
            <span className="text-base font-semibold text-gray-800 min-w-[96px] text-center">{year}년 {MONTH_KR[month - 1]}</span>
            <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none">›</button>
          </div>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            monRate === 100 ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'
          }`}>{monRate}%</div>
          <div>
            <p className="text-xs text-gray-500">모니터링</p>
            <p className="text-sm font-semibold text-gray-700">{completedCount}/{zones.length} 구역</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            Object.keys(calibByDay).length > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'
          }`}>{Object.keys(calibByDay).length}</div>
          <div>
            <p className="text-xs text-gray-500">교정 예정일</p>
            <p className="text-sm font-semibold text-gray-700">이번달</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            ahuTasks.length > 0 ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-400'
          }`}>{ahuTasks.filter(t => t.done).length}/{ahuTasks.length}</div>
          <div>
            <p className="text-xs text-gray-500">AHU 계획</p>
            <p className="text-sm font-semibold text-gray-700">완료/예정</p>
          </div>
        </div>
      </div>

      <div className="flex gap-5">
        {/* Calendar */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {DOW_LABELS.map((d, i) => (
              <div key={d} className={`py-2.5 text-center text-xs font-semibold ${
                i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'
              }`}>{d}</div>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {grid.map((day, idx) => {
                if (!day) {
                  return <div key={idx} className="h-28 bg-gray-50/50 border-r border-b border-gray-100 last:border-r-0" />;
                }

                const calibEvts = calibByDay[day] || [];
                const schedEvts = scheduleByDay[day] || [];
                const maxVisible = 3;
                const shownCalib = Math.min(calibEvts.length, maxVisible);
                const shownSched = Math.min(schedEvts.length, Math.max(0, maxVisible - calibEvts.length));
                const overflow = calibEvts.length + schedEvts.length - shownCalib - shownSched;

                const isToday = isCurrentMonth && day === todayDate;
                const isSelected = day === selectedDay;
                const isDragOver = dragOverDay === day;
                const dow = idx % 7;

                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverDay(day); }}
                    onDragLeave={(e) => {
                      if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDragOverDay(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverDay(null);
                      try {
                        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                        if (data.zoneId !== undefined) handleDropOnDay(day, data);
                      } catch {}
                    }}
                    className={`h-28 p-1.5 border-r border-b border-gray-100 cursor-pointer transition-colors ${
                      isDragOver ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' :
                      isSelected ? 'bg-blue-50' :
                      isToday ? 'bg-blue-50/50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className={`text-xs font-semibold mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                      isToday ? 'bg-blue-600 text-white' :
                      dow === 0 ? 'text-red-500' :
                      dow === 6 ? 'text-blue-500' : 'text-gray-700'
                    }`}>{day}</div>

                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      {calibEvts.slice(0, shownCalib).map((c, i) => (
                        <div
                          key={`c${i}`}
                          className={`text-xs px-1 py-0.5 rounded truncate ${dDayColor(c.next_calib_date)}`}
                          title={`${c.name} (${dDayText(c.next_calib_date)})`}
                        >{c.name}</div>
                      ))}
                      {schedEvts.slice(0, shownSched).map(({ zone, measurement }, i) => {
                        const bounds = getDragBounds(measurement);
                        const label = `${zone.name}[${zone.grade}]-${measurement.num}`;
                        return (
                          <div
                            key={`s${i}`}
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', JSON.stringify({
                                zoneId: zone.id,
                                num: measurement.num,
                                type: measurement.type,
                                minDateStr: format(bounds.min, 'yyyy-MM-dd'),
                                maxDateStr: format(bounds.max, 'yyyy-MM-dd'),
                              }));
                            }}
                            onDragEnd={() => setDragOverDay(null)}
                            onClick={(e) => e.stopPropagation()}
                            className={`text-xs px-1 py-0.5 rounded truncate cursor-grab active:cursor-grabbing ${TYPE_COLORS[measurement.type]}`}
                            title={label}
                          >{label}</div>
                        );
                      })}
                      {overflow > 0 && (
                        <div className="text-xs text-gray-400 px-1">+{overflow}건 더</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />만료됨
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-orange-100 border border-orange-200 inline-block" />7일 이내
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-yellow-50 border border-yellow-200 inline-block" />이번달 교정
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />일1회(P1)
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-blue-100 border border-blue-200 inline-block" />주1회
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-200 inline-block" />격주
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-violet-100 border border-violet-200 inline-block" />월1회
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-64 space-y-3 shrink-0">
          {/* Selected day events */}
          {selectedDay && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-blue-600 text-white">
                <p className="text-xs text-blue-200">{year}년 {MONTH_KR[month - 1]}</p>
                <p className="text-lg font-bold">{selectedDay}일 일정</p>
              </div>

              {selectedCalibEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-orange-50 border-b border-orange-100">
                    <span className="text-xs font-semibold text-orange-600">교정 일정</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {selectedCalibEvents.map(c => (
                      <div key={c.id} className="px-4 py-3">
                        <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">S/N: {c.sn || '-'}</p>
                        <p className={`text-xs font-bold mt-1 ${
                          differenceInDays(parseISO(c.next_calib_date), today) < 0 ? 'text-red-600' : 'text-orange-500'
                        }`}>{dDayText(c.next_calib_date)}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {selectedScheduleEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100">
                    <span className="text-xs font-semibold text-blue-600">측정 일정 ({selectedScheduleEvents.length}건)</span>
                  </div>
                  <div className="divide-y divide-gray-50 max-h-52 overflow-y-auto">
                    {selectedScheduleEvents.map(({ zone, measurement }) => {
                      const bounds = getDragBounds(measurement);
                      return (
                        <div key={`${zone.id}-${measurement.num}`} className="px-4 py-2.5">
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[measurement.type]}`}>
                              {TYPE_LABEL[measurement.type]}
                            </span>
                            <span className="text-xs text-gray-400">#{measurement.num}</span>
                          </div>
                          <p className="text-sm font-medium text-gray-800 truncate">
                            {zone.name}[{zone.grade}]
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            이동: {format(bounds.min, 'MM/dd')}~{format(bounds.max, 'MM/dd')}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {selectedCalibEvents.length === 0 && selectedScheduleEvents.length === 0 && (
                <p className="px-4 py-3 text-sm text-gray-400">일정 없음</p>
              )}
            </div>
          )}

          {/* AHU plan */}
          {ahuTasks.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600">🔧 {MONTH_KR[month - 1]} AHU 계획</p>
              </div>
              <div className="divide-y divide-gray-50">
                {ahuTasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={`text-sm ${t.done ? 'text-green-500' : 'text-gray-300'}`}>{t.done ? '✓' : '○'}</span>
                    <span className={`text-sm flex-1 ${t.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{t.ahuName}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      t.done ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-700'
                    }`}>{t.done ? '완료' : '예정'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Monitoring progress */}
          {zones.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-600">📋 모니터링 현황</p>
                <span className={`text-xs font-bold ${monRate === 100 ? 'text-green-600' : 'text-blue-600'}`}>{monRate}%</span>
              </div>
              <div className="px-4 py-3">
                <div className="w-full bg-gray-100 rounded-full h-2 mb-2 overflow-hidden">
                  <div className={`h-2 rounded-full ${monRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${monRate}%` }} />
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
