import { useState, useEffect } from 'react';
import { fetchWeeklyDuty, saveWeeklyDuty, syncGetConfig, syncUpload } from '../lib/api';

let uid = 0;
function newTaskId() { return `t${Date.now()}_${uid++}`; }

// 관리자가 업무·주차·담당자를 자유롭게 추가·수정·삭제할 수 있는 업무 로테이션
// 담당표. 일일점검·주간점검은 업무별로 주차마다 담당자를 배정하고, 월간점검은
// 항목별로 담당자 한 명씩만 지정한다(구조가 달라 표를 따로 그린다).
export default function WeeklyDuty({ adminUnlocked }) {
  const [duty, setDuty] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    fetchWeeklyDuty().then(setDuty).catch(() => {});
  }, []);

  function showNotice(text, isError) {
    setNotice({ text, isError });
    setTimeout(() => setNotice(null), 3000);
  }
  function requireAdmin() {
    if (!adminUnlocked) { showNotice('관리자 잠금 해제가 필요합니다.', true); return false; }
    return true;
  }

  function updateWeekLabel(idx, value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, weeks: prev.weeks.map((w, i) => i === idx ? value : w) }));
    setDirty(true);
  }
  function addWeek() {
    if (!requireAdmin()) return;
    setDuty(prev => ({
      ...prev,
      weeks: [...prev.weeks, `${prev.weeks.length + 1}주차`],
      dailyTasks: prev.dailyTasks.map(t => ({ ...t, assignments: [...t.assignments, ''] })),
      weeklyTasks: prev.weeklyTasks.map(t => ({ ...t, assignments: [...t.assignments, ''] })),
    }));
    setDirty(true);
  }
  function removeWeek(idx) {
    if (!requireAdmin()) return;
    if (!confirm('이 주차를 삭제하시겠습니까? 해당 주차의 담당자 배정도 함께 사라집니다.')) return;
    setDuty(prev => ({
      ...prev,
      weeks: prev.weeks.filter((_, i) => i !== idx),
      dailyTasks: prev.dailyTasks.map(t => ({ ...t, assignments: t.assignments.filter((_, i) => i !== idx) })),
      weeklyTasks: prev.weeklyTasks.map(t => ({ ...t, assignments: t.assignments.filter((_, i) => i !== idx) })),
    }));
    setDirty(true);
  }
  function addTask(section) {
    if (!requireAdmin()) return;
    setDuty(prev => {
      if (section === 'monthlyTasks') {
        return { ...prev, monthlyTasks: [...prev.monthlyTasks, { id: newTaskId(), name: '', assignee: '' }] };
      }
      return { ...prev, [section]: [...prev[section], { id: newTaskId(), name: '', assignments: prev.weeks.map(() => '') }] };
    });
    setDirty(true);
  }
  function removeTask(section, id) {
    if (!requireAdmin()) return;
    if (!confirm('이 업무를 삭제하시겠습니까?')) return;
    setDuty(prev => ({ ...prev, [section]: prev[section].filter(t => t.id !== id) }));
    setDirty(true);
  }
  function updateTaskName(section, id, value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, [section]: prev[section].map(t => t.id === id ? { ...t, name: value } : t) }));
    setDirty(true);
  }
  function updateAssignment(section, id, weekIdx, value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({
      ...prev,
      [section]: prev[section].map(t => t.id === id ? { ...t, assignments: t.assignments.map((a, i) => i === weekIdx ? value : a) } : t),
    }));
    setDirty(true);
  }
  function updateMonthlyAssignee(id, value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, monthlyTasks: prev.monthlyTasks.map(t => t.id === id ? { ...t, assignee: value } : t) }));
    setDirty(true);
  }
  function updateNotes(value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, notes: value }));
    setDirty(true);
  }

  // 저장 후 공유 설정(토큰)이 있으면 자동으로 Gist에 업로드해 다른 PC에도 곧바로 반영한다.
  async function syncAfterChange() {
    try {
      const cfg = await syncGetConfig();
      if (!cfg?.gistId || !cfg?.hasToken) return;
      await syncUpload();
    } catch { /* 조용히 건너뜀 — 로컬 저장은 이미 성공했으므로 */ }
  }

  async function handleSave() {
    if (!requireAdmin()) return;
    setSaving(true);
    try {
      await saveWeeklyDuty(duty);
      setDirty(false);
      showNotice('저장되었습니다.');
      syncAfterChange();
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    } finally {
      setSaving(false);
    }
  }

  if (!duty) {
    return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">주간근무</h1>
        {adminUnlocked && (
          <button onClick={handleSave} disabled={!dirty || saving}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400'} disabled:opacity-60`}>
            {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </button>
        )}
      </div>
      {!adminUnlocked && (
        <p className="text-xs text-gray-400">🔒 읽기 전용 — 담당자를 바꾸려면 관리자로 로그인하세요.</p>
      )}

      <DutyGrid title="📋 일일점검" tasks={duty.dailyTasks} weeks={duty.weeks} adminUnlocked={adminUnlocked}
        onAddTask={() => addTask('dailyTasks')} onRemoveTask={id => removeTask('dailyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('dailyTasks', id, v)}
        onUpdateAssignment={(id, wi, v) => updateAssignment('dailyTasks', id, wi, v)}
        onUpdateWeekLabel={updateWeekLabel} onAddWeek={addWeek} onRemoveWeek={removeWeek} showWeekControls
      />

      <DutyGrid title="🗓 주간점검 (매주 월요일)" tasks={duty.weeklyTasks} weeks={duty.weeks} adminUnlocked={adminUnlocked}
        onAddTask={() => addTask('weeklyTasks')} onRemoveTask={id => removeTask('weeklyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('weeklyTasks', id, v)}
        onUpdateAssignment={(id, wi, v) => updateAssignment('weeklyTasks', id, wi, v)}
        onUpdateWeekLabel={updateWeekLabel} onAddWeek={addWeek} onRemoveWeek={removeWeek} showWeekControls={false}
      />

      <MonthlySection duty={duty} adminUnlocked={adminUnlocked}
        onAddTask={() => addTask('monthlyTasks')} onRemoveTask={id => removeTask('monthlyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('monthlyTasks', id, v)} onUpdateAssignee={updateMonthlyAssignee}
      />

      <NotesSection notes={duty.notes} adminUnlocked={adminUnlocked} onChange={updateNotes} />

      {notice && (
        <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
          <div className={`px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 ${notice.isError ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}>
            <span className="text-sm font-medium flex-1 leading-snug">{notice.text}</span>
            <button onClick={() => setNotice(null)} className={`text-lg leading-none shrink-0 ${notice.isError ? 'text-red-200 hover:text-white' : 'text-green-200 hover:text-white'}`}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

// 업무 × 주차 배정표 — 일일점검·주간점검 둘 다 이 구조를 쓴다. 주차 열(weeks)은
// 두 표가 공유하므로, 열 추가/삭제 버튼은 showWeekControls가 true인 표에서만 보여준다.
function DutyGrid({ title, tasks, weeks, adminUnlocked, onAddTask, onRemoveTask, onUpdateName, onUpdateAssignment, onUpdateWeekLabel, onAddWeek, onRemoveWeek, showWeekControls }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="font-semibold text-gray-800 text-sm">{title}</span>
        {adminUnlocked && (
          <div className="flex items-center gap-2">
            {showWeekControls && (
              <button onClick={onAddWeek} className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded font-medium">+ 주차 추가</button>
            )}
            <button onClick={onAddTask} className="text-xs px-2 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded font-medium">+ 업무 추가</button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-2 text-left text-gray-500 font-medium min-w-[220px]">업무</th>
              {weeks.map((w, wi) => (
                <th key={wi} className="px-2 py-2 text-center text-gray-500 font-medium min-w-[110px]">
                  <div className="flex items-center justify-center gap-1">
                    <input value={w} disabled={!adminUnlocked} onChange={e => onUpdateWeekLabel(wi, e.target.value)}
                      className="w-full text-center bg-transparent outline-none disabled:text-gray-500" />
                    {showWeekControls && adminUnlocked && weeks.length > 1 && (
                      <button onClick={() => onRemoveWeek(wi)} className="text-gray-300 hover:text-red-500 text-xs shrink-0" title="이 주차 삭제">✕</button>
                    )}
                  </div>
                </th>
              ))}
              {adminUnlocked && <th className="w-8"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {tasks.map(t => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <input value={t.name} disabled={!adminUnlocked} onChange={e => onUpdateName(t.id, e.target.value)}
                    className="w-full bg-transparent outline-none text-gray-800 disabled:text-gray-700" placeholder="업무명" />
                </td>
                {weeks.map((_, wi) => (
                  <td key={wi} className="px-2 py-2 text-center">
                    <input value={t.assignments[wi] || ''} disabled={!adminUnlocked}
                      onChange={e => onUpdateAssignment(t.id, wi, e.target.value)}
                      className="w-full text-center bg-transparent outline-none text-gray-600 disabled:text-gray-500" placeholder="담당자" />
                  </td>
                ))}
                {adminUnlocked && (
                  <td className="text-center">
                    <button onClick={() => onRemoveTask(t.id)} className="text-gray-300 hover:text-red-500 text-xs" title="업무 삭제">✕</button>
                  </td>
                )}
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr><td colSpan={weeks.length + 2} className="px-3 py-6 text-center text-gray-400 text-sm">등록된 업무가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 월간점검 — 항목마다 담당자 한 명(주차 개념 없음)이라 표 구조가 달라 별도로 그린다.
function MonthlySection({ duty, adminUnlocked, onAddTask, onRemoveTask, onUpdateName, onUpdateAssignee }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="font-semibold text-gray-800 text-sm">📅 월간점검 (매월 1일, 말일)</span>
        {adminUnlocked && (
          <button onClick={onAddTask} className="text-xs px-2 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded font-medium">+ 항목 추가</button>
        )}
      </div>
      <div className="divide-y divide-gray-50">
        {duty.monthlyTasks.map(t => (
          <div key={t.id} className="flex items-center gap-3 px-5 py-2.5">
            <input value={t.name} disabled={!adminUnlocked} onChange={e => onUpdateName(t.id, e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm text-gray-800 disabled:text-gray-700" placeholder="점검 항목" />
            <input value={t.assignee || ''} disabled={!adminUnlocked} onChange={e => onUpdateAssignee(t.id, e.target.value)}
              className="w-32 text-center bg-transparent outline-none text-sm text-gray-600 disabled:text-gray-500 border-l border-gray-100 pl-3" placeholder="담당자" />
            {adminUnlocked && (
              <button onClick={() => onRemoveTask(t.id)} className="text-gray-300 hover:text-red-500 text-xs shrink-0" title="항목 삭제">✕</button>
            )}
          </div>
        ))}
        {duty.monthlyTasks.length === 0 && (
          <div className="px-5 py-6 text-center text-gray-400 text-sm">등록된 항목이 없습니다.</div>
        )}
      </div>
    </div>
  );
}

function NotesSection({ notes, adminUnlocked, onChange }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="font-semibold text-gray-800 text-sm">📝 분기점검, 해야할일, 특이사항 및 기타</span>
      </div>
      <div className="p-4">
        <textarea value={notes || ''} disabled={!adminUnlocked} onChange={e => onChange(e.target.value)}
          rows={5} placeholder="분기점검 계획, 해야 할 일, 특이사항 등을 자유롭게 적어두세요."
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-50 disabled:text-gray-500" />
      </div>
    </div>
  );
}
