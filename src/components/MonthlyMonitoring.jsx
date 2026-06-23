import { useState, useEffect, useMemo } from 'react';
import { fetchZones, upsertZone, deleteZone, fetchMonitoringData, upsertMonitoringEntry, fetchCompletions } from '../lib/api';
import { GRADE_TARGETS, GRADE_COLORS } from '../data/initialData';
import { calcMeasurements, GRADE_PRIORITY } from '../lib/schedule';
import { format } from 'date-fns';

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
const CATEGORIES = ['공조', '질소가스', '압축공기'];
const GRADES = ['P1', 'P2', 'P3', '유지관리', 'OQ', 'PQ'];

export default function MonthlyMonitoring({ year, onYearChange }) {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [zones, setZones] = useState([]);
  const [monData, setMonData] = useState({});
  const [completions, setCompletions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [editZone, setEditZone] = useState(null);
  const [showAddZone, setShowAddZone] = useState(false);
  const [zoneForm, setZoneForm] = useState({});
  const [editEntry, setEditEntry] = useState(null);
  const [entryForm, setEntryForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState(null);

  useEffect(() => {
    Promise.all([fetchZones(), fetchCompletions()]).then(([zns, comps]) => {
      setZones(zns);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchMonitoringData(year, month).then(d => { setMonData(d); setLoading(false); });
  }, [year, month]);

  // Group zones by name+category for the grade progression panel
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

  // Schedule-based stats for each zone in the selected month (linked to CalendarView completions)
  const scheduleThisMonth = useMemo(() => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const result = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const ms = calcMeasurements(zone);
      const thisMonthMs = ms.filter(m => format(m.date, 'yyyy-MM') === monthStr);
      if (thisMonthMs.length > 0) {
        const done = thisMonthMs.filter(m => completions.has(`${zone.id}_${m.num}`)).length;
        result[zone.id] = { total: thisMonthMs.length, done };
      }
    });
    return result;
  }, [zones, year, month, completions]);

  // Which zones are currently active (today within schedule window)
  const activeZoneIds = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = new Set();
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const startDate = new Date(zone.schedule_start + 'T00:00:00');
      const ms = calcMeasurements(zone);
      if (!ms.length) return;
      const endDate = ms[ms.length - 1].baseDate;
      if (today >= startDate && today <= endDate) active.add(zone.id);
    });
    return active;
  }, [zones]);

  const filteredZones = useMemo(() => {
    let list = zones;
    if (search) list = list.filter(z => z.name.toLowerCase().includes(search.toLowerCase()) || z.grade.toLowerCase().includes(search.toLowerCase()));
    if (gradeFilter !== 'all') list = list.filter(z => z.grade === gradeFilter);
    return list;
  }, [zones, search, gradeFilter]);

  function getEntry(zoneId) {
    return monData[zoneId] || { airborne: '', settle: '', surface: '', particle: '', count: 0, note: '', start_date: '', done: false };
  }

  function openEntry(zone) {
    setEntryForm({ ...getEntry(zone.id) });
    setEditEntry(zone);
  }

  function getGroupKey(zone) {
    return `${zone.category}|||${zone.name}`;
  }

  async function saveEntry() {
    setSaving(true);
    const payload = {
      zone_id: editEntry.id, year, month,
      airborne: entryForm.airborne || null,
      settle: entryForm.settle || null,
      surface: entryForm.surface || null,
      particle: entryForm.particle || null,
      count: parseInt(entryForm.count) || 0,
      note: entryForm.note || null,
      start_date: entryForm.start_date || null,
      done: entryForm.done || false,
      ...(entryForm.id ? { id: entryForm.id } : {}),
    };
    try {
      const saved = await upsertMonitoringEntry(payload);
      setMonData(p => ({ ...p, [editEntry.id]: saved }));
      setEditEntry(null);
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
    setSaving(false);
  }

  async function quickToggleDone(zone) {
    const sched = scheduleThisMonth[zone.id];
    const entry = getEntry(zone.id);
    const target = sched ? sched.total : (GRADE_TARGETS[zone.grade] || 1);
    const currentDone = sched ? sched.done : (entry.done ? target : (parseInt(entry.count) || 0));
    const isNowDone = currentDone < target;
    const payload = {
      zone_id: zone.id, year, month,
      count: isNowDone ? target : 0,
      done: isNowDone,
      airborne: entry.airborne || null,
      settle: entry.settle || null,
      surface: entry.surface || null,
      particle: entry.particle || null,
      note: entry.note || null,
      start_date: entry.start_date || null,
      ...(entry.id ? { id: entry.id } : {}),
    };
    try {
      const saved = await upsertMonitoringEntry(payload);
      setMonData(p => ({ ...p, [zone.id]: saved }));
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
  }

  async function handleAddZone() {
    if (!zoneForm.name || !zoneForm.grade) return;
    setSaving(true);
    try {
      const saved = await upsertZone({ name: zoneForm.name, grade: zoneForm.grade, category: zoneForm.category || '공조', sort_order: zones.length });
      setZones(p => [...p, saved]);
      setShowAddZone(false);
      setZoneForm({});
    } catch (e) {
      alert('추가 실패: ' + e.message);
    }
    setSaving(false);
  }

  async function handleDeleteZone(id) {
    if (!confirm('구역을 삭제하시겠습니까?')) return;
    await deleteZone(id);
    setZones(p => p.filter(z => z.id !== id));
    if (selectedGroupKey) {
      const remaining = zones.filter(z => z.id !== id && getGroupKey(z) === selectedGroupKey);
      if (!remaining.length) setSelectedGroupKey(null);
    }
  }

  async function saveZoneEdit() {
    setSaving(true);
    try {
      const saved = await upsertZone({ id: editZone.id, name: zoneForm.name, grade: zoneForm.grade, category: zoneForm.category });
      setZones(p => p.map(z => z.id === editZone.id ? saved : z));
      setEditZone(null);
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
    setSaving(false);
  }

  async function handlePanelZoneStart(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  const progress = useMemo(() => {
    let total = 0, done = 0;
    filteredZones.forEach(zone => {
      const sched = scheduleThisMonth[zone.id];
      if (sched) {
        total += sched.total;
        done += sched.done;
      } else {
        const target = GRADE_TARGETS[zone.grade] || 1;
        total += target;
        const entry = monData[zone.id];
        if (entry) done += Math.min(entry.count || 0, target);
      }
    });
    return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [filteredZones, monData, scheduleThisMonth]);

  const selectedGroup = selectedGroupKey ? zoneGroups[selectedGroupKey] : null;
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);

  return (
    <div className="p-6 space-y-4">
      {/* Zone grade progression panel */}
      {selectedGroup && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/30" onClick={() => setSelectedGroupKey(null)} />
          <div className="w-96 h-full bg-white shadow-2xl border-l border-gray-200 flex flex-col">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">{selectedGroup.name}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{selectedGroup.category} · 등급별 일정 설정</p>
              </div>
              <button onClick={() => setSelectedGroupKey(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 text-lg leading-none">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
              {selectedGroup.zones.length === 0 && (
                <p className="px-5 py-4 text-sm text-gray-400">등록된 등급이 없습니다.</p>
              )}
              {selectedGroup.zones.map(zone => {
                const ms = calcMeasurements(zone);
                const endDate = ms.length ? ms[ms.length - 1].baseDate : null;
                const isActive = activeZoneIds.has(zone.id);
                const sched = scheduleThisMonth[zone.id];
                const totalMs = ms.length;
                const completedMs = ms.filter(m => completions.has(`${zone.id}_${m.num}`)).length;
                const isPastDue = endDate && endDate < todayMidnight && !isActive && zone.schedule_start;
                return (
                  <div key={zone.id} className={`px-5 py-4 ${isActive ? 'bg-blue-50/40' : ''}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`text-sm font-bold px-2 py-0.5 rounded ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>
                        {zone.grade}
                      </span>
                      {isActive && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">진행중</span>}
                      {isPastDue && <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">기간 종료</span>}
                      {!zone.schedule_start && <span className="text-xs text-gray-400">일정 없음</span>}
                      <span className="ml-auto text-xs text-gray-400 font-medium">{completedMs}/{totalMs}회</span>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-14 shrink-0">시작일</span>
                        <input
                          type="date"
                          value={zone.schedule_start || ''}
                          onChange={e => handlePanelZoneStart(zone.id, e.target.value)}
                          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      {endDate && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-14 shrink-0">종료예정</span>
                          <span className="text-xs text-blue-600">{format(endDate, 'yyyy.MM.dd')}</span>
                        </div>
                      )}
                      {sched && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-14 shrink-0">이번달</span>
                          <span className={`text-xs font-semibold ${sched.done >= sched.total ? 'text-green-600' : sched.done > 0 ? 'text-blue-600' : 'text-gray-500'}`}>
                            {sched.done}/{sched.total}회 {sched.done >= sched.total ? '완료' : sched.done > 0 ? '진행중' : '예정'}
                          </span>
                        </div>
                      )}
                      {totalMs > 0 && (
                        <div className="mt-2">
                          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
                            <span>전체 진행률</span>
                            <span>{completedMs}/{totalMs}</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${completedMs >= totalMs ? 'bg-green-500' : 'bg-blue-400'}`}
                              style={{ width: `${Math.round((completedMs / totalMs) * 100)}%` }}
                            />
                          </div>
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

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-600">{year}년 {month}월 진행률</span>
          <span className="text-sm font-bold text-blue-600">{progress.pct}% ({progress.done}/{progress.total})</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      </div>

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

      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">구역명</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">등급</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">분류</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">목표</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">완료횟수</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">낙하균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">표면균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유입자</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">상태</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredZones.map(zone => {
                  const entry = getEntry(zone.id);
                  const sched = scheduleThisMonth[zone.id];
                  const isActive = activeZoneIds.has(zone.id);
                  const target = GRADE_TARGETS[zone.grade] || 1;

                  // Use schedule-based count when available (linked to CalendarView completions)
                  const countNum = sched ? sched.done : (parseInt(entry.count) || 0);
                  const countTarget = sched ? sched.total : target;
                  const pct = Math.min(Math.round((countNum / countTarget) * 100), 100);
                  const isComplete = countNum >= countTarget && countTarget > 0;

                  return (
                    <tr key={zone.id} className={`hover:bg-gray-50 ${isActive ? 'bg-blue-50/20' : ''} ${isComplete ? 'bg-green-50/30' : ''}`}>
                      {editZone?.id === zone.id ? (
                        <>
                          <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={zoneForm.name || ''} onChange={e => setZoneForm(f => ({ ...f, name: e.target.value }))} /></td>
                          <td className="px-3 py-2"><select className="border rounded px-1 py-1 text-sm w-full" value={zoneForm.grade || ''} onChange={e => setZoneForm(f => ({ ...f, grade: e.target.value }))}>{GRADES.map(g => <option key={g}>{g}</option>)}</select></td>
                          <td className="px-3 py-2"><select className="border rounded px-1 py-1 text-sm w-full" value={zoneForm.category || ''} onChange={e => setZoneForm(f => ({ ...f, category: e.target.value }))}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></td>
                          <td colSpan={7} className="px-3 py-2 text-center">
                            <button onClick={saveZoneEdit} disabled={saving} className="px-2 py-1 bg-blue-600 text-white rounded text-xs mr-1 disabled:opacity-50">저장</button>
                            <button onClick={() => setEditZone(null)} className="px-2 py-1 bg-gray-200 rounded text-xs">취소</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setSelectedGroupKey(getGroupKey(zone))}
                              className="font-medium text-gray-800 hover:text-blue-600 text-left flex items-center gap-1.5 group"
                            >
                              {zone.name}
                              {isActive && (
                                <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-medium shrink-0">진행중</span>
                              )}
                              <span className="text-gray-300 group-hover:text-blue-400 text-xs shrink-0">›</span>
                            </button>
                          </td>
                          <td className="px-3 py-3 text-center"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span></td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">{zone.category}</td>
                          <td className="px-3 py-3 text-center text-gray-600">{countTarget}</td>
                          <td className="px-3 py-3 text-center">
                            <div className="flex flex-col items-center">
                              <span className={`font-semibold ${isComplete ? 'text-green-600' : 'text-gray-700'}`}>
                                {countNum}/{countTarget}
                              </span>
                              {sched && (
                                <span className="text-[10px] text-blue-500 mt-0.5">달력 연동</span>
                              )}
                              <div className="w-16 h-1 bg-gray-100 rounded-full mt-1">
                                <div className={`h-full rounded-full ${isComplete ? 'bg-green-500' : 'bg-blue-400'}`} style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">{entry.airborne || '-'}</td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">{entry.settle || '-'}</td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">{entry.surface || '-'}</td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">{entry.particle || '-'}</td>
                          <td className="px-3 py-3 text-center">
                            <button
                              onClick={() => quickToggleDone(zone)}
                              className={`text-xs px-2 py-1 rounded-full font-medium ${
                                isComplete ? 'bg-green-100 text-green-700' :
                                countNum > 0 ? 'bg-blue-100 text-blue-700' :
                                isActive ? 'bg-orange-100 text-orange-700' :
                                'bg-gray-100 text-gray-500'
                              }`}
                            >
                              {isComplete ? '완료' : countNum > 0 ? '진행중' : isActive ? '예정' : '미시작'}
                            </button>
                          </td>
                          <td className="px-3 py-3 text-center whitespace-nowrap">
                            <button onClick={() => openEntry(zone)} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded mr-1">입력</button>
                            <button onClick={() => { setEditZone(zone); setZoneForm({ ...zone }); }} className="text-xs px-2 py-1 text-gray-500 hover:bg-gray-100 rounded mr-1">수정</button>
                            <button onClick={() => handleDeleteZone(zone.id)} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
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
              {[{ key: 'airborne', label: '부유균' }, { key: 'settle', label: '낙하균' }, { key: 'surface', label: '표면균' }, { key: 'particle', label: '부유입자' }].map(({ key, label }) => (
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

      {/* 구역 추가 모달 */}
      {showAddZone && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-800">구역 추가</h2>
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
