import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, upsertZone, fetchGroups, upsertGroup, deleteGroup } from '../lib/api';
import { parseISO, differenceInDays, format } from 'date-fns';
import { calcMeasurements, calcEndDate, totalCount, getDragBounds, NEXT_GRADE, GRADE_PRIORITY, NTH_LABEL, DOW_LABEL } from '../lib/schedule';
import { GRADE_COLORS, CATEGORY_SECTION } from '../data/initialData';

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const TYPE_COLORS = {
  daily:    'bg-red-100 text-red-700 border border-red-200',
  weekly:   'bg-blue-100 text-blue-700 border border-blue-200',
  biweekly: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  monthly:  'bg-violet-100 text-violet-700 border border-violet-200',
};

const CAT_CHIP_BG = {
  '공조':   'bg-gray-100 border border-gray-200',
  '질소가스': 'bg-purple-100 border border-purple-200',
  '압축공기': 'bg-yellow-100 border border-yellow-200',
};
const GRADE_CHIP_TEXT = {
  'P1': 'text-red-700',
  'P2': 'text-green-700',
  'P3': 'text-blue-700',
  '유지관리': 'text-indigo-900',
};

const TYPE_LABEL = { daily: '일1회', weekly: '주1회', biweekly: '격주', monthly: '월1회' };

function buildGrid(year, month) {
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthDays = new Date(prevYear, prevMonth, 0).getDate();
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, year: prevYear, month: prevMonth, isOther: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, year, month, isOther: false });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: nextDay++, year: nextYear, month: nextMonth, isOther: true });
  }
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
  const [settingsTab, setSettingsTab] = useState('zones'); // 'zones' | 'groups'
  const [dragOverDay, setDragOverDay] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [groups, setGroups] = useState([]);
  const [phasePrompt, setPhasePrompt] = useState(null); // { zoneId, zoneName, nextGrade, dateStr }
  const [newGroupName, setNewGroupName] = useState('');
  const [zonesCatFilter, setZonesCatFilter] = useState('전체');
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
      fetchGroups(),
    ]).then(([cal, zns, mon, plan, grps]) => {
      setCalibration(cal);
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setGroups(grps);
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

  // Calibration events by date string
  const calibByDate = {};
  calibration.forEach(c => {
    if (!c.next_calib_date) return;
    try {
      const key = c.next_calib_date.slice(0, 10);
      if (!calibByDate[key]) calibByDate[key] = [];
      calibByDate[key].push(c);
    } catch {}
  });

  // Schedule events by date string (all dates, no month filter)
  const scheduleByDate = useMemo(() => {
    const map = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      calcMeasurements(zone).forEach(m => {
        const key = format(m.date, 'yyyy-MM-dd');
        if (!map[key]) map[key] = [];
        map[key].push({ zone, measurement: m });
      });
    });
    return map;
  }, [zones]);

  // Group zones by (category, name) for settings drawer
  const zoneGroups = useMemo(() => {
    const groupMap = {};
    zones.forEach(zone => {
      const key = `${zone.category}|||${zone.name}`;
      if (!groupMap[key]) groupMap[key] = { name: zone.name, category: zone.category, zones: [] };
      groupMap[key].zones.push(zone);
    });
    Object.values(groupMap).forEach(g => {
      g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
    });
    return Object.values(groupMap);
  }, [zones]);

  // Monitoring stats
  const completedCount = zones.filter(z => monitoring[z.id]).length;
  const monRate = zones.length ? Math.round(completedCount / zones.length * 100) : 0;

  // AHU tasks this month
  const allAhuEntries = Object.entries(annualPlan)
    .filter(([, val]) => val.planned)
    .map(([key, val]) => {
      const parts = key.split('_');
      const taskMonth = parseInt(parts[parts.length - 1]);
      const ahuName = parts.slice(0, -1).join('_');
      return { ahuName, month: taskMonth, done: val.done };
    });
  const ahuTasksWithNth = allAhuEntries.map(t => ({
    ...t,
    nth: allAhuEntries.filter(e => e.ahuName === t.ahuName && e.month <= t.month).length,
  }));
  const ahuTasks = ahuTasksWithNth.sort((a, b) => {
    const aOff = a.month >= month ? a.month - month : a.month + 12 - month;
    const bOff = b.month >= month ? b.month - month : b.month + 12 - month;
    return aOff - bOff || a.ahuName.localeCompare(b.ahuName);
  });
  const currentMonthAhuTasks = ahuTasks.filter(t => t.month === month);

  const curMonthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const totalMonthSchedule = Object.entries(scheduleByDate)
    .filter(([k]) => k.startsWith(curMonthPrefix))
    .reduce((sum, [, arr]) => sum + arr.length, 0);
  const calibThisMonthCount = Object.keys(calibByDate).filter(k => k.startsWith(curMonthPrefix)).length;
  const scheduledZonesCount = zones.filter(z => z.schedule_start && ['P1','P2','P3'].includes(z.grade)).length;

  const grid = buildGrid(year, month);
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  const selectedCalibEvents = selectedDay ? (calibByDate[selectedDay] || []) : [];
  const selectedScheduleEvents = selectedDay ? (scheduleByDate[selectedDay] || []) : [];

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

    // Validate: start date must not be before the previous grade's end date
    const PREV_GRADE = { P2: 'P1', P3: 'P2', '유지관리': 'P3' };
    const prevGrade = PREV_GRADE[zone.grade];
    if (dateStr && prevGrade) {
      const prevZone = zones.find(z =>
        z.name === zone.name && z.category === zone.category && z.grade === prevGrade
      );
      if (prevZone?.schedule_start) {
        const prevMs = calcMeasurements(prevZone);
        if (prevMs.length) {
          const prevEndDate = prevMs[prevMs.length - 1].baseDate;
          const newStart = new Date(dateStr + 'T00:00:00');
          if (newStart < prevEndDate) {
            showError(
              `${zone.grade} 시작일은 ${prevGrade} 종료예정일(${format(prevEndDate, 'yyyy.MM.dd')}) 이후로 설정해야 합니다.`
            );
            return;
          }
        }
      }
    }

    // Propagate to all zones in the same group
    const group = groups.find(g => g.zoneIds.includes(zoneId));
    if (group) {
      const groupZones = zones.filter(z => group.zoneIds.includes(z.id));
      const updates = await Promise.all(
        groupZones.map(z => {
          const u = { ...z, schedule_start: dateStr || null, schedule_overrides: {} };
          return upsertZone(u).then(() => u);
        })
      );
      setZones(prev => prev.map(z => {
        const u = updates.find(u => u.id === z.id);
        return u || z;
      }));
    } else {
      const updated = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
      await upsertZone(updated);
      setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
    }
  }

  async function handlePhaseTransition(zoneId, newGrade, newStartDate) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone || !newStartDate) return;
    const updated = { ...zone, grade: newGrade, schedule_start: newStartDate, schedule_overrides: {} };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
    setPhasePrompt(null);
  }

  async function handleSetWeekdayRule(zoneId, rule) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, monthly_weekday_rule: rule };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  async function handleSaveGroup(group) {
    const saved = await upsertGroup(group);
    setGroups(prev => {
      const idx = prev.findIndex(g => g.id === saved.id);
      return idx >= 0 ? prev.map(g => g.id === saved.id ? saved : g) : [...prev, saved];
    });
    setNewGroupName('');
  }

  async function handleDeleteGroup(id) {
    await deleteGroup(id);
    setGroups(prev => prev.filter(g => g.id !== id));
  }

  async function handleSetZonePoint(zoneId, field, value) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, [field]: value };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  async function handleSyncGroup(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const groupZones = zones.filter(z => group.zoneIds.includes(z.id) && z.schedule_start);
    if (groupZones.length === 0) return;
    // Find anchor: zone with highest grade priority (P1 > P2 > P3)
    const anchor = groupZones.reduce((best, z) => {
      return (GRADE_PRIORITY[z.grade] || 0) > (GRADE_PRIORITY[best.grade] || 0) ? z : best;
    });
    const toSync = groupZones.filter(z => z.id !== anchor.id && z.schedule_start !== anchor.schedule_start);
    if (!toSync.length) return;
    const updates = await Promise.all(
      toSync.map(z => {
        const u = { ...z, schedule_start: anchor.schedule_start, schedule_overrides: {} };
        return upsertZone(u).then(() => u);
      })
    );
    setZones(prev => prev.map(z => {
      const u = updates.find(u => u.id === z.id);
      return u || z;
    }));
  }

  async function handleDropOnDay(dateStr, dragData) {
    const zone = zones.find(z => z.id === dragData.zoneId);
    if (!zone) return;

    if (dateStr < dragData.minDateStr || dateStr > dragData.maxDateStr) {
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
        [String(dragData.num)]: dateStr,
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

      {/* Phase transition modal */}
      {phasePrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6">
            <h3 className="text-base font-bold text-gray-900 mb-1">단계 전환</h3>
            <p className="text-sm text-gray-500 mb-4">
              <span className="font-semibold text-gray-700">{phasePrompt.zoneName}</span> 구역의{' '}
              <span className={`font-bold px-1.5 py-0.5 rounded text-xs ${GRADE_COLORS[phasePrompt.nextGrade] || 'bg-gray-100 text-gray-600'}`}>
                {phasePrompt.nextGrade}
              </span>{' '}
              시작일을 설정하세요.
            </p>
            <label className="block text-xs text-gray-500 mb-1">{phasePrompt.nextGrade} 시작일</label>
            <input
              type="date"
              value={phasePrompt.dateStr}
              onChange={e => setPhasePrompt(prev => ({ ...prev, dateStr: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPhasePrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
              >취소</button>
              <button
                onClick={() => handlePhaseTransition(phasePrompt.zoneId, phasePrompt.nextGrade, phasePrompt.dateStr)}
                disabled={!phasePrompt.dateStr}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40"
              >{phasePrompt.nextGrade}로 전환</button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule settings drawer */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/30" onClick={() => setShowSettings(false)} />
          <div className="w-[520px] h-full bg-white shadow-2xl border-l border-gray-200 flex flex-col">
            {/* Drawer header */}
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">모니터링 일정 설정</h2>
                <p className="text-xs text-gray-400 mt-0.5">{scheduledZonesCount}개 구역 설정됨 · {groups.length}개 그룹</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0">
              {[['zones','구역 일정'],['groups','그룹 관리']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSettingsTab(key)}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    settingsTab === key
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >{label}</button>
              ))}
            </div>

            {/* ── 구역 일정 탭 ── */}
            {settingsTab === 'zones' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                {/* Category sub-tabs */}
                <div className="flex gap-1.5 px-4 py-2.5 border-b border-gray-100 shrink-0">
                  {['전체', '공조', '질소가스', '압축공기'].map(cat => (
                    <button
                      key={cat}
                      onClick={() => setZonesCatFilter(cat)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        zonesCatFilter === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >{cat}</button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {(zonesCatFilter === '전체' ? ['공조', '압축공기', '질소가스'] : [zonesCatFilter]).map(cat => {
                    const catGroups = zoneGroups.filter(g => g.category === cat);
                    if (!catGroups.length) return null;
                    return (
                      <div key={cat}>
                        <div className={`px-4 py-2 border-b sticky top-0 z-10 ${CATEGORY_SECTION[cat]?.bg || 'bg-gray-50'} ${CATEGORY_SECTION[cat]?.border || 'border-gray-100'}`}>
                          <span className={`text-xs font-bold ${CATEGORY_SECTION[cat]?.text || 'text-gray-500'}`}>{cat}</span>
                          <span className={`ml-2 text-xs opacity-70 ${CATEGORY_SECTION[cat]?.text || 'text-gray-400'}`}>{catGroups.length}개 구역</span>
                        </div>
                        {catGroups.map(group => {
                          const groupKey = `${group.category}_${group.name}`;
                          const isExpanded = expandedGroups.has(groupKey);
                          const myGroup = groups.find(g => group.zones.some(z => g.zoneIds.includes(z.id)));
                          const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
                          const activeZone = group.zones.find(zone => {
                            if (!zone.schedule_start) return false;
                            const startDate = new Date(zone.schedule_start + 'T00:00:00');
                            if (startDate > todayMidnight) return false;
                            const ms = calcMeasurements(zone);
                            if (!ms.length) return true;
                            return todayMidnight <= ms[ms.length - 1].baseDate;
                          });
                          const zonesToShow = isExpanded ? group.zones : (activeZone ? [activeZone] : []);
                          return (
                            <div key={groupKey} className="border-b border-gray-100">
                              {/* Group header */}
                              <button
                                className="w-full px-4 pt-3 pb-2 flex items-center gap-2 text-left hover:bg-gray-50/60 transition-colors"
                                onClick={() => setExpandedGroups(prev => {
                                  const next = new Set(prev);
                                  if (next.has(groupKey)) next.delete(groupKey);
                                  else next.add(groupKey);
                                  return next;
                                })}
                              >
                                <span className="text-sm font-semibold text-gray-800 flex-1 truncate">{group.name}</span>
                                {myGroup && (
                                  <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded shrink-0">{myGroup.name}</span>
                                )}
                                {!isExpanded && activeZone && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${GRADE_COLORS[activeZone.grade] || 'bg-gray-100 text-gray-600'}`}>{activeZone.grade}</span>
                                )}
                                {!isExpanded && !activeZone && (
                                  <span className="text-xs text-gray-400 shrink-0">계획없음</span>
                                )}
                                <span className="text-gray-400 text-xs shrink-0">{isExpanded ? '▲' : '▼'}</span>
                              </button>
                              {!isExpanded && !activeZone && (
                                <div className="px-4 pb-3 text-xs text-gray-400 italic">계획일정 없음</div>
                              )}
                              {/* Grade rows */}
                              {zonesToShow.map(zone => {
                                const ms = calcMeasurements(zone);
                                const done = ms.filter(m => m.date <= todayMidnight).length;
                                const total = ms.length || totalCount(zone);
                                const endDate = ms.length ? ms[ms.length - 1].baseDate : null;
                                const isPastDue = endDate && endDate < todayMidnight && NEXT_GRADE[zone.grade];
                                return (
                                  <div key={zone.id} className={`px-3 py-2 ${isPastDue ? 'bg-amber-50/60' : ''}`}>
                                    <div className="flex items-start gap-2">
                                      {/* Grade + progress */}
                                      <div className="flex flex-col items-start gap-0.5 w-[68px] shrink-0">
                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>
                                          {zone.grade}
                                        </span>
                                        <span className={`text-xs tabular-nums ${isPastDue ? 'text-amber-600 font-semibold' : 'text-gray-400'}`}>
                                          {done}/{total}회
                                        </span>
                                      </div>
                                      {/* Date info */}
                                      <div className="flex flex-col gap-0.5 w-[120px] shrink-0">
                                        <input
                                          type="date"
                                          value={zone.schedule_start || ''}
                                          onChange={e => handleSetZoneStart(zone.id, e.target.value)}
                                          className="text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
                                        />
                                        {endDate && (
                                          <span className="text-xs text-blue-600">→ {format(endDate, 'yyyy.MM.dd')}</span>
                                        )}
                                        {zone.grade === 'P3' && (
                                          <div className="flex items-center gap-1 flex-wrap mt-0.5">
                                            <span className="text-xs text-gray-400">매월</span>
                                            <select
                                              value={zone.monthly_weekday_rule?.nth ?? ''}
                                              onChange={e => {
                                                const nth = e.target.value ? Number(e.target.value) : null;
                                                handleSetWeekdayRule(zone.id, nth ? { nth, dow: zone.monthly_weekday_rule?.dow ?? 1 } : null);
                                              }}
                                              className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                                            >
                                              <option value="">날짜</option>
                                              <option value="1">1째</option>
                                              <option value="2">2째</option>
                                              <option value="3">3째</option>
                                              <option value="4">4째</option>
                                              <option value="5">마지막</option>
                                            </select>
                                            {zone.monthly_weekday_rule?.nth && (
                                              <>
                                                <span className="text-xs text-gray-400">주</span>
                                                <select
                                                  value={zone.monthly_weekday_rule?.dow ?? 1}
                                                  onChange={e => handleSetWeekdayRule(zone.id, { ...zone.monthly_weekday_rule, dow: Number(e.target.value) })}
                                                  className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                                                >
                                                  {DOW_LABEL.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
                                                </select>
                                              </>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      {/* Sampling points 4-col (label over input) */}
                                      <div className="grid grid-cols-4 gap-x-1.5 gap-y-1 shrink-0">
                                        {[
                                          ['points_surface', '표면균'],
                                          ['points_float', '부유균'],
                                          ['points_fall', '낙하균'],
                                          ['points_particle', '부유입자'],
                                        ].map(([field, label]) => (
                                          <div key={field} className="flex flex-col items-center gap-0.5">
                                            <span className="text-[10px] leading-none text-gray-400">{label}</span>
                                            <input
                                              type="number"
                                              min="0"
                                              max="999"
                                              defaultValue={zone[field] ?? ''}
                                              onBlur={e => handleSetZonePoint(zone.id, field, parseInt(e.target.value) || 0)}
                                              className="w-12 text-xs border border-gray-200 rounded px-0.5 py-0.5 text-center focus:outline-none focus:ring-1 focus:ring-blue-400"
                                              placeholder="0"
                                            />
                                          </div>
                                        ))}
                                      </div>
                                      {/* Phase transition */}
                                      {isPastDue && (
                                        <button
                                          onClick={() => setPhasePrompt({ zoneId: zone.id, zoneName: zone.name, nextGrade: NEXT_GRADE[zone.grade], dateStr: '' })}
                                          className="text-xs bg-amber-500 text-white px-1.5 py-1 rounded-lg hover:bg-amber-600 shrink-0"
                                        >→{NEXT_GRADE[zone.grade]}</button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              <div className="h-1" />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 그룹 관리 탭 ── */}
            {settingsTab === 'groups' && (
              <div className="flex-1 overflow-y-auto">
                {/* New group input */}
                <div className="px-5 py-3 border-b border-gray-100 shrink-0">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="새 그룹 이름..."
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newGroupName.trim()) {
                          handleSaveGroup({ name: newGroupName.trim(), zoneIds: [] });
                        }
                      }}
                      className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => { if (newGroupName.trim()) handleSaveGroup({ name: newGroupName.trim(), zoneIds: [] }); }}
                      className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
                    >추가</button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">그룹 내 구역들은 시작일이 자동으로 동기화됩니다.</p>
                </div>
                {groups.length === 0 && (
                  <p className="px-5 py-4 text-sm text-gray-400">그룹이 없습니다. 위에서 새 그룹을 만드세요.</p>
                )}
                {groups.map(group => {
                  const groupZones = zones.filter(z => group.zoneIds.includes(z.id));
                  return (
                    <div key={group.id} className="px-5 py-4 border-b border-gray-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold text-gray-800">{group.name}</span>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleSyncGroup(group.id)}
                            title="가장 높은 등급 구역 기준으로 시작일 동기화"
                            className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 font-medium"
                          >동기화</button>
                          <button
                            onClick={() => handleDeleteGroup(group.id)}
                            className="text-xs px-2 py-1 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"
                          >삭제</button>
                        </div>
                      </div>
                      {/* Zone chips in group */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {groupZones.length === 0 && (
                          <span className="text-xs text-gray-400">구역 없음</span>
                        )}
                        {groupZones.map(z => (
                          <div key={z.id} className="flex items-center gap-1 bg-gray-100 rounded-full pl-2 pr-1 py-0.5">
                            <span className={`text-xs font-bold px-1 py-0.5 rounded ${GRADE_COLORS[z.grade] || 'bg-gray-200 text-gray-600'}`}>{z.grade}</span>
                            <span className="text-xs text-gray-700 max-w-[80px] truncate">{z.name}</span>
                            <button
                              onClick={() => handleSaveGroup({ ...group, zoneIds: group.zoneIds.filter(id => id !== z.id) })}
                              className="text-gray-400 hover:text-red-500 text-xs leading-none px-0.5"
                            >✕</button>
                          </div>
                        ))}
                      </div>
                      {/* Add zone to group */}
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          if (!e.target.value || group.zoneIds.includes(e.target.value)) return;
                          handleSaveGroup({ ...group, zoneIds: [...group.zoneIds, e.target.value] });
                          e.target.value = '';
                        }}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">구역 추가...</option>
                        {['공조','압축공기','질소가스'].map(c => {
                          const opts = zones.filter(z =>
                            z.category === c &&
                            !group.zoneIds.includes(z.id) &&
                            ['P1','P2','P3'].includes(z.grade)
                          );
                          if (!opts.length) return null;
                          return (
                            <optgroup key={c} label={c}>
                              {opts.map(z => (
                                <option key={z.id} value={z.id}>
                                  {z.name}[{z.grade}]{z.schedule_start ? ' ' + z.schedule_start : ''}
                                </option>
                              ))}
                            </optgroup>
                          );
                        })}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
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
            calibThisMonthCount > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'
          }`}>{calibThisMonthCount}</div>
          <div>
            <p className="text-xs text-gray-500">교정 예정일</p>
            <p className="text-sm font-semibold text-gray-700">이번달</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            currentMonthAhuTasks.length > 0 ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-400'
          }`}>{currentMonthAhuTasks.filter(t => t.done).length}/{currentMonthAhuTasks.length}</div>
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
              {grid.map((cell, idx) => {
                const { day, isOther } = cell;
                const dateStr = `${cell.year}-${String(cell.month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const calibEvts = calibByDate[dateStr] || [];
                const schedEvts = scheduleByDate[dateStr] || [];

                const isToday = !isOther && isCurrentMonth && day === todayDate;
                const isSelected = dateStr === selectedDay;
                const isDragOver = dragOverDay === dateStr;
                const dow = idx % 7;

                const pts = schedEvts.reduce((acc, { zone }) => ({
                  surface: acc.surface + (zone.points_surface || 0),
                  float: acc.float + (zone.points_float || 0),
                  fall: acc.fall + (zone.points_fall || 0),
                  particle: acc.particle + (zone.points_particle || 0),
                }), { surface: 0, float: 0, fall: 0, particle: 0 });
                const hasPts = pts.surface + pts.float + pts.fall + pts.particle > 0;

                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedDay(dateStr === selectedDay ? null : dateStr)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverDay(dateStr); }}
                    onDragLeave={(e) => {
                      if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDragOverDay(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverDay(null);
                      try {
                        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                        if (data.zoneId !== undefined) handleDropOnDay(dateStr, data);
                      } catch {}
                    }}
                    className={`min-h-28 p-1.5 border-r border-b border-gray-100 cursor-pointer transition-colors ${
                      isDragOver ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' :
                      isOther ? 'bg-gray-50/80' :
                      isSelected ? 'bg-blue-50' :
                      isToday ? 'bg-blue-50/50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1 gap-0.5">
                      <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full shrink-0 ${
                        isOther ? 'text-gray-300' :
                        isToday ? 'bg-blue-600 text-white' :
                        dow === 0 ? 'text-red-500' :
                        dow === 6 ? 'text-blue-500' : 'text-gray-700'
                      }`}>{day}</div>
                      {hasPts && (
                        <div className={`flex gap-0.5 flex-wrap justify-end overflow-hidden ${isOther ? 'opacity-40' : ''}`}>
                          {pts.surface > 0 && <span className="text-[9px] leading-none bg-green-50 text-green-700 px-0.5 py-0.5 rounded">표{pts.surface}</span>}
                          {pts.float > 0 && <span className="text-[9px] leading-none bg-blue-50 text-blue-700 px-0.5 py-0.5 rounded">부{pts.float}</span>}
                          {pts.fall > 0 && <span className="text-[9px] leading-none bg-orange-50 text-orange-700 px-0.5 py-0.5 rounded">낙{pts.fall}</span>}
                          {pts.particle > 0 && <span className="text-[9px] leading-none bg-purple-50 text-purple-700 px-0.5 py-0.5 rounded">입{pts.particle}</span>}
                        </div>
                      )}
                    </div>

                    <div className={`flex flex-col gap-0.5 ${isOther ? 'opacity-40' : ''}`}>
                      {calibEvts.map((c, i) => (
                        <div
                          key={`c${i}`}
                          className={`text-xs px-1 py-0.5 rounded break-words ${dDayColor(c.next_calib_date)}`}
                          title={`${c.name} (${dDayText(c.next_calib_date)})`}
                        >{c.name}</div>
                      ))}
                      {schedEvts.map(({ zone, measurement }, i) => {
                        const bounds = getDragBounds(measurement);
                        const label = `${zone.name}[${zone.grade}]-${measurement.num}`;
                        return (
                          <div
                            key={`s${i}`}
                            draggable={true}
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
                            className={`text-xs px-1 py-0.5 rounded break-words ${CAT_CHIP_BG[zone.category] || 'bg-gray-100 border border-gray-200'} ${GRADE_CHIP_TEXT[zone.grade] || 'text-gray-600'} cursor-grab active:cursor-grabbing`}
                            style={{
                              borderLeft: measurement.isFirst ? '3px solid #22c55e' : undefined,
                              borderRight: measurement.isLast ? '3px solid #ef4444' : undefined,
                              fontWeight: (measurement.isFirst || measurement.isLast) ? 600 : undefined,
                            }}
                            title={`${label}${measurement.isFirst ? ' [첫 측정]' : measurement.isLast ? ' [마지막 측정]' : ''}`}
                          >{label}</div>
                        );
                      })}
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
              <span className="w-3 h-3 rounded bg-gray-100 border border-gray-200 inline-block" />공조
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-purple-100 border border-purple-200 inline-block" />질소가스
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-yellow-100 border border-yellow-200 inline-block" />압축공기
            </div>
            <div className="flex items-center gap-1.5 text-xs"><span className="text-red-700 font-semibold">P1</span><span className="text-green-700 font-semibold">P2</span><span className="text-blue-700 font-semibold">P3</span><span className="text-indigo-900 font-semibold">유지관리</span></div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block w-3 h-3 rounded" style={{ borderLeft: '3px solid #22c55e' }} />첫 측정
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block w-3 h-3 rounded" style={{ borderRight: '3px solid #ef4444' }} />마지막 측정
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-64 shrink-0 flex flex-col gap-3">
          {/* Selected day events */}
          {selectedDay && (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col flex-1 min-h-0">
              <div className="px-4 py-3 bg-blue-600 text-white shrink-0">
                <p className="text-xs text-blue-200">{selectedDay.slice(0,4)}년 {MONTH_KR[parseInt(selectedDay.slice(5,7)) - 1]}</p>
                <p className="text-lg font-bold">{parseInt(selectedDay.slice(8,10))}일 일정</p>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">

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
                  <div className="divide-y divide-gray-50">
                    {selectedScheduleEvents.map(({ zone, measurement }) => {
                      const bounds = getDragBounds(measurement);
                      return (
                        <div
                          key={`${zone.id}-${measurement.num}`}
                          className="px-4 py-2.5"
                          style={{
                            borderLeft: measurement.isFirst ? '3px solid #22c55e' : measurement.isLast ? '3px solid #ef4444' : undefined,
                          }}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <div className="flex items-center gap-1">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${CAT_CHIP_BG[zone.category] || 'bg-gray-100 border border-gray-200'} ${GRADE_CHIP_TEXT[zone.grade] || 'text-gray-600'}`}>
                                {zone.grade}
                              </span>
                              {measurement.isFirst && <span className="text-xs text-green-600 font-bold">첫측정</span>}
                              {measurement.isLast && <span className="text-xs text-red-600 font-bold">마지막</span>}
                            </div>
                            <span className="text-xs text-gray-400">#{measurement.num}</span>
                          </div>
                          <p className="text-sm font-medium text-gray-800 truncate">
                            {zone.name}[{zone.grade}]
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            이동: {format(bounds.min, 'MM/dd')}~{format(bounds.max, 'MM/dd')}
                          </p>
                          {(zone.points_surface || zone.points_float || zone.points_fall || zone.points_particle) ? (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {zone.points_surface > 0 && <span className="text-[10px] bg-green-50 text-green-600 px-1 py-0.5 rounded">표면균 {zone.points_surface}pt</span>}
                              {zone.points_float > 0 && <span className="text-[10px] bg-blue-50 text-blue-600 px-1 py-0.5 rounded">부유균 {zone.points_float}pt</span>}
                              {zone.points_fall > 0 && <span className="text-[10px] bg-orange-50 text-orange-600 px-1 py-0.5 rounded">낙하균 {zone.points_fall}pt</span>}
                              {zone.points_particle > 0 && <span className="text-[10px] bg-purple-50 text-purple-600 px-1 py-0.5 rounded">부유입자 {zone.points_particle}pt</span>}
                            </div>
                          ) : null}
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
            </div>
          )}

          {/* AHU plan */}
          {ahuTasks.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600">🔧 AHU 계획</p>
              </div>
              <div className="divide-y divide-gray-50 max-h-52 overflow-y-auto">
                {ahuTasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={`text-sm shrink-0 ${t.done ? 'text-green-500' : 'text-gray-300'}`}>{t.done ? '✓' : '○'}</span>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm block truncate ${t.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{t.ahuName}</span>
                      <span className="text-xs text-gray-400">{t.month}월 · 올해 {t.nth}번째</span>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                      t.done ? 'bg-green-100 text-green-600' :
                      t.month === month ? 'bg-yellow-100 text-yellow-700' :
                      t.month > month ? 'bg-blue-50 text-blue-500' : 'bg-gray-100 text-gray-400'
                    }`}>{t.done ? '완료' : t.month === month ? '이번달' : `${t.month}월`}</span>
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
