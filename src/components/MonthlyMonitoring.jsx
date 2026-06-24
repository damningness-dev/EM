import { useState, useEffect, useMemo, Fragment } from 'react';
import { fetchZones, upsertZone, deleteZone, fetchMonitoringData, upsertMonitoringEntry, fetchCompletions, fetchHolidays } from '../lib/api';
import { GRADE_TARGETS, GRADE_COLORS, CLEAN_GRADES, CLEAN_GRADE_COLORS } from '../data/initialData';
import { calcMeasurements, calcEndDate, GRADE_PRIORITY, buildHolidayMap, computeCascadeSchedules } from '../lib/schedule';
import { format } from 'date-fns';

const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const CATEGORIES = ['공조', '질소가스', '압축공기'];
const GRADES = ['P1', 'P2', 'P3', '유지관리', 'OQ', 'PQ'];
const PROGRESSION = ['P1', 'P2', 'P3', '유지관리'];

export default function MonthlyMonitoring({ year, onYearChange }) {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [zones, setZones] = useState([]);
  const [monData, setMonData] = useState({});
  const [completions, setCompletions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [showAddZone, setShowAddZone] = useState(false);
  const [zoneForm, setZoneForm] = useState({});
  const [editEntry, setEditEntry] = useState(null);
  const [entryForm, setEntryForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { id, name }
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    Promise.all([fetchZones(), fetchCompletions(), fetchHolidays()]).then(([zns, comps, hols]) => {
      // 레거시 '청정등급' 분류 → '공조'로 이관 (청정등급은 이제 각 일정의 속성)
      const legacy = zns.filter(z => z.category === '청정등급');
      if (legacy.length) {
        legacy.forEach(z => upsertZone({ ...z, category: '공조' }));
        zns = zns.map(z => z.category === '청정등급' ? { ...z, category: '공조' } : z);
      }
      setZones(zns);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
      setHolidayDefs(hols);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchMonitoringData(year, month).then(d => { setMonData(d); setLoading(false); });
  }, [year, month]);

  // Group all zones by name+category; one P1/P2/P3/유지관리 per group
  const zoneGroups = useMemo(() => {
    const map = {};
    zones.forEach(zone => {
      const key = `${zone.category}|||${zone.name}`;
      if (!map[key]) map[key] = { name: zone.name, category: zone.category, key, zones: [] };
      map[key].zones.push(zone);
    });
    Object.values(map).forEach(g => {
      g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
    });
    return map;
  }, [zones]);

  // Schedule-based stats per zone for this month (linked to CalendarView completions)
  const scheduleThisMonth = useMemo(() => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const result = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const ms = calcMeasurements(zone);
      const thisMonthMs = ms.filter(m => format(m.date, 'yyyy-MM') === monthStr);
      if (thisMonthMs.length) {
        result[zone.id] = {
          total: thisMonthMs.length,
          done: thisMonthMs.filter(m => completions.has(`${zone.id}_${m.num}`)).length,
        };
      }
    });
    return result;
  }, [zones, year, month, completions]);

  // Which zones are currently within their schedule window
  const activeZoneIds = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = new Set();
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const start = new Date(zone.schedule_start + 'T00:00:00');
      const end = calcEndDate(zone);
      if (!end) return;
      if (today >= start && today <= end) active.add(zone.id);
    });
    return active;
  }, [zones]);

  const filteredGroups = useMemo(() => {
    let groups = Object.values(zoneGroups);
    if (search) groups = groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
    if (gradeFilter !== 'all') groups = groups.filter(g => g.zones.some(z => z.grade === gradeFilter && activeZoneIds.has(z.id)));
    return groups;
  }, [zoneGroups, search, gradeFilter, activeZoneIds]);

  const progress = useMemo(() => {
    let total = 0, done = 0;
    filteredGroups.forEach(group => {
      group.zones.forEach(zone => {
        const sched = scheduleThisMonth[zone.id];
        if (sched) {
          total += sched.total; done += sched.done;
        } else {
          const target = GRADE_TARGETS[zone.grade] || 1;
          total += target;
          const e = monData[zone.id];
          if (e) done += Math.min(e.count || 0, target);
        }
      });
    });
    return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [filteredGroups, monData, scheduleThisMonth]);

  function getEntry(zoneId) {
    return monData[zoneId] || { airborne:'', settle:'', surface:'', particle:'', count:0, note:'', start_date:'', done:false };
  }

  function getActiveZone(group) {
    return group.zones.find(z => activeZoneIds.has(z.id)) || group.zones[0];
  }

  function toggleGroup(key) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function handleZoneStart(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));

    if (dateStr && ['P1', 'P2', 'P3'].includes(updated.grade)) {
      const startYear = new Date(dateStr).getFullYear();
      const holidayMap = buildHolidayMap(holidayDefs, startYear, startYear + 4);
      const cascadeItems = computeCascadeSchedules(updated, zones, holidayMap);
      if (cascadeItems.length > 0) {
        const cascaded = [];
        for (const { zoneData } of cascadeItems) {
          const saved = await upsertZone(zoneData);
          cascaded.push(saved);
        }
        setZones(prev => {
          const next = [...prev];
          for (const cz of cascaded) {
            const idx = next.findIndex(z => z.id === cz.id);
            if (idx >= 0) next[idx] = cz; else next.push(cz);
          }
          return next;
        });
      }
    }
  }

  async function addGradeToGroup(group, grade) {
    if (group.zones.some(z => z.grade === grade)) return;
    try {
      const cleanGrade = group.zones.find(z => z.clean_grade)?.clean_grade || null;
      const saved = await upsertZone({ name: group.name, category: group.category, grade, clean_grade: cleanGrade, sort_order: zones.length, schedule_overrides: {} });
      setZones(prev => [...prev, saved]);
    } catch (e) { setErrorMsg('추가 실패: ' + e.message); }
  }

  async function handleDeleteConfirmed() {
    const ids = deleteConfirm.ids;
    for (const id of ids) await deleteZone(id);
    setZones(p => p.filter(z => !ids.includes(z.id)));
    setDeleteConfirm(null);
  }

  async function handleChangeGroupCategory(group, newCategory) {
    if (!newCategory || newCategory === group.category) return;
    // Block if a group with the same name already exists under the target category
    const targetKey = `${newCategory}|||${group.name}`;
    if (zoneGroups[targetKey]) {
      setErrorMsg(`동일한 구역명이 존재합니다 "${group.name}"`);
      return;
    }
    const updates = await Promise.all(group.zones.map(z => {
      const u = { ...z, category: newCategory };
      return upsertZone(u).then(() => u);
    }));
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
  }

  // 청정등급 부여 — 그룹 전체 또는 단일 일정(zone)에 적용
  async function handleSetCleanGrade(zoneIds, value) {
    const ids = Array.isArray(zoneIds) ? zoneIds : [zoneIds];
    const cleanGrade = value || null;
    const updates = await Promise.all(zones.filter(z => ids.includes(z.id)).map(z => {
      const u = { ...z, clean_grade: cleanGrade };
      return upsertZone(u).then(() => u);
    }));
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
  }

  async function saveEntry() {
    setSaving(true);
    const payload = {
      zone_id: editEntry.id, year, month,
      airborne: entryForm.airborne || null, settle: entryForm.settle || null,
      surface: entryForm.surface || null, particle: entryForm.particle || null,
      count: parseInt(entryForm.count) || 0, note: entryForm.note || null,
      start_date: entryForm.start_date || null, done: entryForm.done || false,
      ...(entryForm.id ? { id: entryForm.id } : {}),
    };
    try {
      const saved = await upsertMonitoringEntry(payload);
      setMonData(p => ({ ...p, [editEntry.id]: saved }));
      setEditEntry(null);
    } catch (e) { setErrorMsg('저장 실패: ' + e.message); }
    setSaving(false);
  }

  async function handleAddZone() {
    if (!zoneForm.name || !zoneForm.grade) return;
    const groupKey = `${zoneForm.category || '공조'}|||${zoneForm.name}`;
    const existing = zoneGroups[groupKey];
    if (existing && PROGRESSION.includes(zoneForm.grade) && existing.zones.some(z => z.grade === zoneForm.grade)) {
      setErrorMsg(`동일한 구역명이 존재합니다 "${zoneForm.name}"`);
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertZone({ name: zoneForm.name, grade: zoneForm.grade, category: zoneForm.category || '공조', clean_grade: zoneForm.clean_grade || null, sort_order: zones.length, schedule_overrides: {} });
      setZones(p => [...p, saved]);
      setShowAddZone(false);
      setZoneForm({});
    } catch (e) { setErrorMsg('추가 실패: ' + e.message); }
    setSaving(false);
  }

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">월별 환경 모니터링</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1">
            <button onClick={() => onYearChange(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
            <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
            <button onClick={() => onYearChange(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {MONTHS.map((m, i) => (
              <button key={i} onClick={() => setMonth(i + 1)} className={`px-3 py-1.5 text-sm transition-colors ${month === i + 1 ? 'bg-blue-600 text-white' : 'hover:bg-gray-50 text-gray-600'}`}>{i + 1}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-600">{year}년 {month}월 진행률</span>
          <span className="text-sm font-bold text-blue-600">{progress.pct}% ({progress.done}/{progress.total})</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input type="text" placeholder="구역명 검색..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setGradeFilter('all')} className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === 'all' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>전체</button>
          {GRADES.map(g => (
            <button key={g} onClick={() => setGradeFilter(g)} className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{g}</button>
          ))}
        </div>
        <button onClick={() => { setShowAddZone(true); setZoneForm({}); }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 ml-auto">+ 구역 추가</button>
      </div>

      {/* Table */}
      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="w-8 px-3 py-3"></th>
                  <th className="text-left px-3 py-3 text-gray-500 font-medium">구역명</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">분류</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">청정등급</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">활성등급</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">이번달</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">낙하균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">표면균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유입자</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">상태</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">관리</th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.map(group => {
                  const isExpanded = expandedGroups.has(group.key);
                  const activeZone = getActiveZone(group);
                  const isGroupActive = group.zones.some(z => activeZoneIds.has(z.id));
                  const sched = activeZone ? scheduleThisMonth[activeZone.id] : null;
                  const entry = activeZone ? getEntry(activeZone.id) : null;
                  const countTarget = sched ? sched.total : (GRADE_TARGETS[activeZone?.grade] || 1);
                  const countNum = sched ? sched.done : (parseInt(entry?.count) || 0);
                  const isComplete = countNum >= countTarget && countTarget > 0;
                  const gradeMap = {};
                  group.zones.forEach(z => { gradeMap[z.grade] = z; });

                  return (
                    <Fragment key={group.key}>
                      {/* Group summary row */}
                      <tr
                        className={`border-b border-gray-100 cursor-pointer select-none hover:bg-gray-50/50 ${isExpanded ? 'bg-blue-50/30 border-blue-100' : ''} ${isGroupActive && !isExpanded ? 'bg-blue-50/10' : ''}`}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <td className="px-3 py-3 text-center text-gray-400 text-xs font-bold">{isExpanded ? '▼' : '▶'}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-gray-800">{group.name}</span>
                            {isGroupActive && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-medium">진행중</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <select
                            value={group.category}
                            onChange={e => handleChangeGroupCategory(group, e.target.value)}
                            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <select
                            value={activeZone?.clean_grade || ''}
                            onChange={e => handleSetCleanGrade(group.zones.map(z => z.id), e.target.value)}
                            className={`text-xs border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 font-semibold ${activeZone?.clean_grade ? (CLEAN_GRADE_COLORS[activeZone.clean_grade] || 'bg-white text-gray-600') + ' border-transparent' : 'bg-white text-gray-400 border-gray-200'}`}
                          >
                            <option value="">-</option>
                            {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {activeZone && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${GRADE_COLORS[activeZone.grade] || 'bg-gray-100 text-gray-600'}`}>
                              {activeZone.grade}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-center">
                          {countTarget > 0 ? (
                            <div className="flex flex-col items-center">
                              <span className={`font-semibold text-xs ${isComplete ? 'text-green-600' : 'text-gray-700'}`}>{countNum}/{countTarget}</span>
                              {sched && <span className="text-[9px] text-blue-500 mt-0.5">달력연동</span>}
                            </div>
                          ) : <span className="text-gray-300 text-xs">-</span>}
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">{entry?.airborne || '-'}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">{entry?.settle || '-'}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">{entry?.surface || '-'}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">{entry?.particle || '-'}</td>
                        <td className="px-3 py-3 text-center">
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                            isComplete ? 'bg-green-100 text-green-700' :
                            countNum > 0 ? 'bg-blue-100 text-blue-700' :
                            isGroupActive ? 'bg-orange-100 text-orange-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>
                            {isComplete ? '완료' : countNum > 0 ? '진행중' : isGroupActive ? '예정' : '미시작'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            {activeZone && (
                              <button
                                onClick={() => { setEntryForm({ ...getEntry(activeZone.id) }); setEditEntry(activeZone); }}
                                className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                              >수정</button>
                            )}
                            <button
                              onClick={() => setDeleteConfirm({ ids: group.zones.map(z => z.id), name: group.name })}
                              className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded"
                            >삭제</button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded grade progression */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={12} className="p-0">
                            <div className="bg-gray-50 border-b-2 border-blue-100 px-6 py-3 space-y-2">
                              {PROGRESSION.map(grade => {
                                const zone = gradeMap[grade];
                                if (zone) {
                                  const ms = calcMeasurements(zone);
                                  const endDate = calcEndDate(zone);
                                  const isActive = activeZoneIds.has(zone.id);
                                  const zoneSched = scheduleThisMonth[zone.id];
                                  const totalMs = ms.length;
                                  const completedMs = ms.filter(m => completions.has(`${zone.id}_${m.num}`)).length;
                                  const pct = totalMs > 0 ? Math.round((completedMs / totalMs) * 100) : 0;
                                  return (
                                    <div key={grade} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 border ${isActive ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-100'}`}>
                                      <span className={`text-xs font-bold px-2 py-1 rounded shrink-0 ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                                      {isActive && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-medium shrink-0">진행중</span>}
                                      <select
                                        value={zone.clean_grade || ''}
                                        onChange={e => handleSetCleanGrade(zone.id, e.target.value)}
                                        onClick={e => e.stopPropagation()}
                                        title="청정등급"
                                        className={`text-[10px] border rounded px-1 py-0.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 font-semibold ${zone.clean_grade ? (CLEAN_GRADE_COLORS[zone.clean_grade] || 'bg-white text-gray-600') + ' border-transparent' : 'bg-white text-gray-400 border-gray-200'}`}
                                      >
                                        <option value="">청정-</option>
                                        {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}등급</option>)}
                                      </select>
                                      <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
                                        <span className="text-xs text-gray-400 shrink-0">시작일</span>
                                        <input
                                          type="date"
                                          value={zone.schedule_start || ''}
                                          onChange={e => handleZoneStart(zone.id, e.target.value)}
                                          onClick={e => e.stopPropagation()}
                                          className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32 shrink-0"
                                        />
                                        {endDate && (
                                          <span className="text-xs text-blue-600 shrink-0">→ {format(endDate, 'yyyy.MM.dd')}</span>
                                        )}
                                        {totalMs > 0 && (
                                          <div className="flex items-center gap-1.5 shrink-0">
                                            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                              <div className={`h-full rounded-full ${completedMs >= totalMs ? 'bg-green-500' : 'bg-blue-400'}`} style={{ width: `${pct}%` }} />
                                            </div>
                                            <span className="text-[10px] text-gray-400">{completedMs}/{totalMs}</span>
                                          </div>
                                        )}
                                        {zoneSched && (
                                          <span className="text-xs shrink-0">
                                            이번달 <span className={`font-semibold ${zoneSched.done >= zoneSched.total ? 'text-green-600' : 'text-blue-600'}`}>{zoneSched.done}/{zoneSched.total}</span>
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => { setEntryForm({ ...getEntry(zone.id) }); setEditEntry(zone); }} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-100 rounded">수정</button>
                                        <button onClick={() => setDeleteConfirm({ ids: [zone.id], name: `${zone.name}[${zone.grade}]` })} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div key={grade} className="flex items-center gap-3 rounded-lg px-3 py-2 border border-dashed border-gray-200 bg-white/60">
                                    <span className={`text-xs font-bold px-2 py-1 rounded opacity-30 shrink-0 ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                                    <span className="text-xs text-gray-400 flex-1">등록되지 않음</span>
                                    <button
                                      onClick={e => { e.stopPropagation(); addGradeToGroup(group, grade); }}
                                      className="text-xs px-2.5 py-1 bg-gray-100 text-gray-500 hover:bg-gray-200 rounded font-medium shrink-0"
                                    >+ 추가</button>
                                  </div>
                                );
                              })}
                              {/* OQ / PQ if present */}
                              {group.zones.filter(z => !PROGRESSION.includes(z.grade)).map(zone => (
                                <div key={zone.id} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-white border border-gray-100">
                                  <span className={`text-xs font-bold px-2 py-1 rounded shrink-0 ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                                  <span className="text-xs text-gray-500 flex-1">{zone.name}</span>
                                  <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                    <button onClick={() => { setEntryForm({ ...getEntry(zone.id) }); setEditEntry(zone); }} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-100 rounded">수정</button>
                                    <button onClick={() => setDeleteConfirm({ ids: [zone.id], name: `${zone.name}[${zone.grade}]` })} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {filteredGroups.length === 0 && (
                  <tr><td colSpan={12} className="px-4 py-8 text-center text-sm text-gray-400">구역이 없습니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 데이터 입력 모달 */}
      {editEntry && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="font-bold text-gray-800">{editEntry.name} <span className={`text-xs px-2 py-0.5 rounded-full ml-2 ${GRADE_COLORS[editEntry.grade]}`}>{editEntry.grade}</span></h2>
            <p className="text-sm text-gray-500">{year}년 {month}월 모니터링 데이터 입력</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">시작일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.start_date || ''} onChange={e => setEntryForm(f => ({ ...f, start_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">완료 횟수 (목표: {GRADE_TARGETS[editEntry.grade] || 1}회)</label>
                <input type="number" min="0" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.count || ''} onChange={e => setEntryForm(f => ({ ...f, count: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[['airborne','부유균'],['settle','낙하균'],['surface','표면균'],['particle','부유입자']].map(([key, label]) => (
                <div key={key}>
                  <label className="text-xs text-gray-500">{label}</label>
                  <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" placeholder="측정값" value={entryForm[key] || ''} onChange={e => setEntryForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div>
              <label className="text-xs text-gray-500">비고</label>
              <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5 h-16 resize-none" value={entryForm.note || ''} onChange={e => setEntryForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={saveEntry} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">저장</button>
              <button onClick={() => setEditEntry(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* Error toast */}
      {errorMsg && (
        <div className="fixed top-4 right-4 z-[200] bg-red-500 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 max-w-sm">
          <span className="text-base shrink-0 mt-0.5">⚠</span>
          <span className="text-sm font-medium flex-1 leading-snug">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-red-200 hover:text-white text-lg leading-none shrink-0">✕</button>
        </div>
      )}

      {/* 삭제 확인 모달 */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-gray-800">구역 삭제</h2>
            <p className="text-sm text-gray-500">
              <span className="font-semibold text-gray-700">{deleteConfirm.name}</span>
              {deleteConfirm.ids.length > 1 ? ` 그룹(${deleteConfirm.ids.length}개 등급)을` : ' 구역을'} 삭제하시겠습니까?
              이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2 pt-1">
              <button onClick={handleDeleteConfirmed}
                className="flex-1 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600">삭제</button>
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 구역 추가 모달 */}
      {showAddZone && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-800">구역 추가</h2>
            <p className="text-xs text-gray-400">같은 이름+분류의 구역은 자동으로 그룹화됩니다. P1/P2/P3/유지관리는 그룹 내 각 1개까지 허용됩니다.</p>
            <div>
              <label className="text-xs text-gray-500">구역명</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.name || ''} onChange={e => setZoneForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">등급</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.grade || ''} onChange={e => setZoneForm(f => ({ ...f, grade: e.target.value }))}>
                  <option value="">선택</option>
                  {GRADES.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">분류</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.category || '공조'} onChange={e => setZoneForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">청정등급</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.clean_grade || ''} onChange={e => setZoneForm(f => ({ ...f, clean_grade: e.target.value }))}>
                <option value="">미지정</option>
                {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}등급</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={handleAddZone} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">추가</button>
              <button onClick={() => setShowAddZone(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">취소</button>
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
