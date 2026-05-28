import { useState } from 'react';
import { AHU_LIST } from '../data/initialData';
import { getAnnualPlan, saveAnnualPlan, getAnnualPlanKey, getYear, setYear } from '../utils/storage';

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

export default function AnnualPlan() {
  const [year, setYearState] = useState(getYear);
  const [plan, setPlan] = useState(getAnnualPlan);
  const [ahus, setAhus] = useState(AHU_LIST);
  const [newAhu, setNewAhu] = useState('');
  const [editCell, setEditCell] = useState(null);
  const [noteForm, setNoteForm] = useState('');

  function changeYear(y) {
    setYearState(y);
    setYear(y);
  }

  function togglePlanned(ahu, month) {
    const key = getAnnualPlanKey(year, ahu, month);
    const current = plan[key] || {};
    const updated = {
      ...plan,
      [key]: { ...current, planned: !current.planned, done: !current.planned ? current.done : false },
    };
    setPlan(updated);
    saveAnnualPlan(updated);
  }

  function toggleDone(ahu, month) {
    const key = getAnnualPlanKey(year, ahu, month);
    const current = plan[key] || {};
    if (!current.planned) return;
    const updated = { ...plan, [key]: { ...current, done: !current.done } };
    setPlan(updated);
    saveAnnualPlan(updated);
  }

  function openNote(ahu, month) {
    const key = getAnnualPlanKey(year, ahu, month);
    setNoteForm((plan[key] || {}).note || '');
    setEditCell({ ahu, month });
  }

  function saveNote() {
    const { ahu, month } = editCell;
    const key = getAnnualPlanKey(year, ahu, month);
    const updated = { ...plan, [key]: { ...(plan[key] || {}), note: noteForm } };
    setPlan(updated);
    saveAnnualPlan(updated);
    setEditCell(null);
  }

  function addAhu() {
    if (!newAhu.trim() || ahus.includes(newAhu.trim())) return;
    setAhus(prev => [...prev, newAhu.trim()]);
    setNewAhu('');
  }

  // 각 AHU별 완료율 계산
  function ahuStats(ahu) {
    let planned = 0, done = 0;
    for (let m = 1; m <= 12; m++) {
      const entry = plan[getAnnualPlanKey(year, ahu, m)] || {};
      if (entry.planned) { planned++; if (entry.done) done++; }
    }
    return { planned, done };
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">연간 계획 (AHU 유지보수)</h1>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <button onClick={() => changeYear(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
            <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
            <button onClick={() => changeYear(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
          </div>
        </div>
      </div>

      {/* 범례 */}
      <div className="flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-blue-300 rounded inline-block"></span> 계획</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-green-500 rounded inline-block"></span> 완료</span>
        <span className="text-gray-400">셀 클릭: 계획 설정 / 완료 칸 클릭: 완료 토글</span>
      </div>

      {/* 테이블 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-4 py-3 text-gray-500 font-medium border-b border-r border-gray-200 whitespace-nowrap">AHU</th>
                {MONTHS.map(m => (
                  <th key={m} className="text-center px-2 py-3 text-gray-500 font-medium border-b border-gray-200 min-w-[80px]">{m}</th>
                ))}
                <th className="text-center px-4 py-3 text-gray-500 font-medium border-b border-l border-gray-200">진행</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ahus.map(ahu => {
                const stats = ahuStats(ahu);
                return (
                  <tr key={ahu} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2 font-medium text-gray-700 border-r border-gray-100 whitespace-nowrap">{ahu}</td>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
                      const key = getAnnualPlanKey(year, ahu, month);
                      const entry = plan[key] || {};
                      return (
                        <td key={month} className="px-1 py-1.5 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <button
                              onClick={() => togglePlanned(ahu, month)}
                              className={`w-full h-7 rounded text-xs font-medium transition-colors ${
                                entry.planned
                                  ? 'bg-blue-100 border border-blue-300 text-blue-700'
                                  : 'border border-gray-100 text-gray-300 hover:border-gray-300 hover:text-gray-400'
                              }`}
                            >
                              {entry.planned ? '계획' : '+'}
                            </button>
                            {entry.planned && (
                              <button
                                onClick={() => toggleDone(ahu, month)}
                                className={`w-full h-6 rounded text-xs font-medium transition-colors ${
                                  entry.done
                                    ? 'bg-green-500 text-white'
                                    : 'bg-gray-100 text-gray-400 hover:bg-green-100'
                                }`}
                              >
                                {entry.done ? '완료' : '미완'}
                              </button>
                            )}
                            {entry.planned && (
                              <button
                                onClick={() => openNote(ahu, month)}
                                className="text-xs text-gray-300 hover:text-gray-500 truncate max-w-full"
                                title={entry.note}
                              >
                                {entry.note ? '📝' : '메모'}
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-2 text-center border-l border-gray-100">
                      <span className={`text-sm font-semibold ${stats.planned > 0 ? 'text-gray-700' : 'text-gray-300'}`}>
                        {stats.done}/{stats.planned}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* AHU 추가 */}
      <div className="flex gap-2">
        <input
          value={newAhu}
          onChange={e => setNewAhu(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addAhu()}
          placeholder="AHU 추가 (예: AHU-50)"
          className="flex-1 max-w-xs px-3 py-2 border border-gray-200 rounded-lg text-sm"
        />
        <button onClick={addAhu} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">추가</button>
      </div>

      {/* 메모 모달 */}
      {editCell && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-800">{editCell.ahu} - {editCell.month}월 메모</h2>
            <textarea
              className="w-full border rounded-lg px-3 py-2 text-sm h-24 resize-none"
              value={noteForm}
              onChange={e => setNoteForm(e.target.value)}
              placeholder="메모 입력..."
            />
            <div className="flex gap-2">
              <button onClick={saveNote} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">저장</button>
              <button onClick={() => setEditCell(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
