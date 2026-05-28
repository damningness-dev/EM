import { useState, useEffect } from 'react';
import { fetchAnnualPlan, upsertAnnualPlan } from '../lib/api';

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
const DEFAULT_AHUS = ['AHU-01', 'AHU-02', 'AHU-15', 'AHU-16', 'AHU-19', 'AHU-31', 'AHU-32', 'AHU-33', 'AHU-34', 'AHU-42', 'AHU-43'];

export default function AnnualPlan({ year, onYearChange }) {
  const [plan, setPlan] = useState({});
  const [ahus, setAhus] = useState(DEFAULT_AHUS);
  const [newAhu, setNewAhu] = useState('');
  const [loading, setLoading] = useState(true);
  const [editCell, setEditCell] = useState(null);
  const [noteForm, setNoteForm] = useState('');

  useEffect(() => {
    setLoading(true);
    fetchAnnualPlan(year).then(p => { setPlan(p); setLoading(false); });
  }, [year]);

  async function togglePlanned(ahu, month) {
    const key = `${ahu}_${month}`;
    const current = plan[key] || {};
    const newPlanned = !current.planned;
    const payload = {
      ahu_name: ahu, year, month,
      planned: newPlanned,
      done: newPlanned ? (current.done || false) : false,
      note: current.note || '',
      ...(current.id ? { id: current.id } : {}),
    };
    try {
      const saved = await upsertAnnualPlan(payload);
      setPlan(p => ({ ...p, [key]: saved }));
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
  }

  async function toggleDone(ahu, month) {
    const key = `${ahu}_${month}`;
    const current = plan[key] || {};
    if (!current.planned) return;
    const payload = { ...current, ahu_name: ahu, year, month, done: !current.done };
    try {
      const saved = await upsertAnnualPlan(payload);
      setPlan(p => ({ ...p, [key]: saved }));
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
  }

  async function saveNote() {
    const { ahu, month } = editCell;
    const key = `${ahu}_${month}`;
    const current = plan[key] || {};
    const payload = { ...current, ahu_name: ahu, year, month, note: noteForm };
    try {
      const saved = await upsertAnnualPlan(payload);
      setPlan(p => ({ ...p, [key]: saved }));
      setEditCell(null);
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
  }

  function ahuStats(ahu) {
    let planned = 0, done = 0;
    for (let m = 1; m <= 12; m++) {
      const entry = plan[`${ahu}_${m}`] || {};
      if (entry.planned) { planned++; if (entry.done) done++; }
    }
    return { planned, done };
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">연간 계획 (AHU 유지보수)</h1>
        <div className="flex gap-1">
          <button onClick={() => onYearChange(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
          <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
          <button onClick={() => onYearChange(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
        </div>
      </div>

      <div className="flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-blue-300 rounded inline-block"></span> 계획</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-green-500 rounded inline-block"></span> 완료</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-4 py-3 text-gray-500 font-medium border-b border-r border-gray-200 whitespace-nowrap">AHU</th>
                {MONTHS.map(m => <th key={m} className="text-center px-2 py-3 text-gray-500 font-medium border-b border-gray-200 min-w-[80px]">{m}</th>)}
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
                      const entry = plan[`${ahu}_${month}`] || {};
                      return (
                        <td key={month} className="px-1 py-1.5 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <button onClick={() => togglePlanned(ahu, month)} className={`w-full h-7 rounded text-xs font-medium transition-colors ${entry.planned ? 'bg-blue-100 border border-blue-300 text-blue-700' : 'border border-gray-100 text-gray-300 hover:border-gray-300'}`}>
                              {entry.planned ? '계획' : '+'}
                            </button>
                            {entry.planned && (
                              <button onClick={() => toggleDone(ahu, month)} className={`w-full h-6 rounded text-xs font-medium transition-colors ${entry.done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-green-100'}`}>
                                {entry.done ? '완료' : '미완'}
                              </button>
                            )}
                            {entry.planned && (
                              <button onClick={() => { setNoteForm(entry.note || ''); setEditCell({ ahu, month }); }} className="text-xs text-gray-300 hover:text-gray-500" title={entry.note}>
                                {entry.note ? '📝' : '메모'}
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-2 text-center border-l border-gray-100">
                      <span className={`text-sm font-semibold ${stats.planned > 0 ? 'text-gray-700' : 'text-gray-300'}`}>{stats.done}/{stats.planned}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex gap-2">
        <input value={newAhu} onChange={e => setNewAhu(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAhu()} placeholder="AHU 추가 (예: AHU-50)" className="flex-1 max-w-xs px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        <button onClick={() => { if (!newAhu.trim() || ahus.includes(newAhu.trim())) return; setAhus(p => [...p, newAhu.trim()]); setNewAhu(''); }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">추가</button>
      </div>

      {editCell && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-800">{editCell.ahu} - {editCell.month}월 메모</h2>
            <textarea className="w-full border rounded-lg px-3 py-2 text-sm h-24 resize-none" value={noteForm} onChange={e => setNoteForm(e.target.value)} placeholder="메모 입력..." />
            <div className="flex gap-2">
              <button onClick={saveNote} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">저장</button>
              <button onClick={() => setEditCell(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">취소</button>
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
