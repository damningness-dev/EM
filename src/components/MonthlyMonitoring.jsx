import { useState, useMemo } from 'react';
import { getMonitoringZones, saveMonitoringZones, getMonitoringData, saveMonitoringData, getMonitoringKey, getYear, setYear } from '../utils/storage';
import { GRADE_TARGETS, GRADE_COLORS } from '../data/initialData';

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
const CATEGORIES = ['공조', '질소가스', '압축공기'];
const GRADES = ['P1', 'P2', 'P3', '유지관리', 'OQ', 'PQ'];

export default function MonthlyMonitoring() {
  const [year, setYearState] = useState(getYear);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [zones, setZones] = useState(getMonitoringZones);
  const [monData, setMonData] = useState(getMonitoringData);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [editZone, setEditZone] = useState(null);
  const [showAddZone, setShowAddZone] = useState(false);
  const [zoneForm, setZoneForm] = useState({});
  const [editEntry, setEditEntry] = useState(null);
  const [entryForm, setEntryForm] = useState({});
  const [view, setView] = useState('table'); // table | status

  function changeYear(y) {
    setYearState(y);
    setYear(y);
  }

  const filteredZones = useMemo(() => {
    let list = zones;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(z => z.name.toLowerCase().includes(q) || z.grade.toLowerCase().includes(q) || z.category.toLowerCase().includes(q));
    }
    if (gradeFilter !== 'all') list = list.filter(z => z.grade === gradeFilter);
    return list;
  }, [zones, search, gradeFilter]);

  function getEntry(zoneId) {
    const key = getMonitoringKey(year, month, zoneId);
    return monData[key] || { airborne: '', settle: '', surface: '', particle: '', count: 0, note: '', startDate: '', done: false };
  }

  function openEntry(zone) {
    const entry = getEntry(zone.id);
    setEntryForm({ ...entry });
    setEditEntry(zone);
  }

  function saveEntry() {
    const key = getMonitoringKey(year, month, editEntry.id);
    const updated = { ...monData, [key]: { ...entryForm } };
    setMonData(updated);
    saveMonitoringData(updated);
    setEditEntry(null);
  }

  function quickToggleDone(zone) {
    const key = getMonitoringKey(year, month, zone.id);
    const current = monData[key] || {};
    const target = GRADE_TARGETS[zone.grade] || 1;
    const newCount = current.done ? 0 : target;
    const updated = { ...monData, [key]: { ...current, count: newCount, done: !current.done } };
    setMonData(updated);
    saveMonitoringData(updated);
  }

  function addZone() {
    if (!zoneForm.name || !zoneForm.grade) return;
    const newZone = { id: Date.now(), name: zoneForm.name, grade: zoneForm.grade, category: zoneForm.category || '공조' };
    const updated = [...zones, newZone];
    setZones(updated);
    saveMonitoringZones(updated);
    setShowAddZone(false);
    setZoneForm({});
  }

  function deleteZone(id) {
    if (!confirm('구역을 삭제하시겠습니까?')) return;
    const updated = zones.filter(z => z.id !== id);
    setZones(updated);
    saveMonitoringZones(updated);
  }

  function saveZoneEdit() {
    const updated = zones.map(z => z.id === editZone.id ? { ...z, ...zoneForm } : z);
    setZones(updated);
    saveMonitoringZones(updated);
    setEditZone(null);
  }

  // 이번 달 전체 진행률
  const progress = useMemo(() => {
    let total = 0, done = 0;
    filteredZones.forEach(zone => {
      const target = GRADE_TARGETS[zone.grade] || 1;
      total += target;
      const entry = monData[getMonitoringKey(year, month, zone.id)];
      if (entry) done += Math.min(entry.count || 0, target);
    });
    return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [filteredZones, monData, year, month]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">월별 환경 모니터링</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1">
            <button onClick={() => changeYear(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
            <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
            <button onClick={() => changeYear(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {MONTHS.map((m, i) => (
              <button
                key={i}
                onClick={() => setMonth(i + 1)}
                className={`px-3 py-1.5 text-sm transition-colors ${month === i + 1 ? 'bg-blue-600 text-white' : 'hover:bg-gray-50 text-gray-600'}`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 진행률 바 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-600">{year}년 {month}월 진행률</span>
          <span className="text-sm font-bold text-blue-600">{progress.pct}% ({progress.done}/{progress.total})</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      </div>

      {/* 필터/검색 */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="구역명 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm"
        />
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setGradeFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === 'all' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
          >
            전체
          </button>
          {GRADES.map(g => (
            <button
              key={g}
              onClick={() => setGradeFilter(g)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
              {g}
            </button>
          ))}
        </div>
        <button
          onClick={() => { setShowAddZone(true); setZoneForm({}); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 ml-auto"
        >
          + 구역 추가
        </button>
      </div>

      {/* 메인 테이블 */}
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
                const target = GRADE_TARGETS[zone.grade] || 1;
                const countNum = parseInt(entry.count) || 0;
                const pct = Math.min(Math.round((countNum / target) * 100), 100);
                const isComplete = countNum >= target;
                return (
                  <tr key={zone.id} className={`hover:bg-gray-50 ${isComplete ? 'bg-green-50/30' : ''}`}>
                    {editZone?.id === zone.id ? (
                      <>
                        <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-sm" value={zoneForm.name || ''} onChange={e => setZoneForm(f => ({ ...f, name: e.target.value }))} /></td>
                        <td className="px-3 py-2">
                          <select className="border rounded px-1 py-1 text-sm w-full" value={zoneForm.grade || ''} onChange={e => setZoneForm(f => ({ ...f, grade: e.target.value }))}>
                            {GRADES.map(g => <option key={g}>{g}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select className="border rounded px-1 py-1 text-sm w-full" value={zoneForm.category || ''} onChange={e => setZoneForm(f => ({ ...f, category: e.target.value }))}>
                            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                          </select>
                        </td>
                        <td colSpan={7} className="px-3 py-2 text-center">
                          <button onClick={saveZoneEdit} className="px-2 py-1 bg-blue-600 text-white rounded text-xs mr-1">저장</button>
                          <button onClick={() => setEditZone(null)} className="px-2 py-1 bg-gray-200 rounded text-xs">취소</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 font-medium text-gray-800">{zone.name}</td>
                        <td className="px-3 py-3 text-center">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">{zone.category}</td>
                        <td className="px-3 py-3 text-center text-gray-600">{target}</td>
                        <td className="px-3 py-3 text-center">
                          <div className="flex flex-col items-center">
                            <span className={`font-semibold ${isComplete ? 'text-green-600' : 'text-gray-700'}`}>{countNum}/{target}</span>
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
                              isComplete ? 'bg-green-100 text-green-700' : countNum > 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {isComplete ? '완료' : countNum > 0 ? '진행중' : '예정'}
                          </button>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <button onClick={() => openEntry(zone)} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded mr-1">입력</button>
                          <button onClick={() => { setEditZone(zone); setZoneForm({ ...zone }); }} className="text-xs px-2 py-1 text-gray-500 hover:bg-gray-100 rounded mr-1">수정</button>
                          <button onClick={() => deleteZone(zone.id)} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
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

      {/* 데이터 입력 모달 */}
      {editEntry && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="font-bold text-gray-800">{editEntry.name} <span className={`text-xs px-2 py-0.5 rounded-full ml-2 ${GRADE_COLORS[editEntry.grade]}`}>{editEntry.grade}</span></h2>
            <p className="text-sm text-gray-500">{year}년 {month}월 모니터링 데이터 입력</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">시작일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.startDate || ''} onChange={e => setEntryForm(f => ({ ...f, startDate: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">완료 횟수 (목표: {GRADE_TARGETS[editEntry.grade] || 1}회)</label>
                <input type="number" min="0" max={GRADE_TARGETS[editEntry.grade] || 1} className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.count || ''} onChange={e => setEntryForm(f => ({ ...f, count: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'airborne', label: '부유균' },
                { key: 'settle', label: '낙하균' },
                { key: 'surface', label: '표면균' },
                { key: 'particle', label: '부유입자' },
              ].map(({ key, label }) => (
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
              <button onClick={saveEntry} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">저장</button>
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
              <button onClick={addZone} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">추가</button>
              <button onClick={() => setShowAddZone(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
