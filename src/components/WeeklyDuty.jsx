import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { fetchWeeklyDuty, saveWeeklyDuty, syncWeeklyDutyTodosNow, syncGetConfig, syncUpload } from '../lib/api';

let uid = 0;
function newTaskId() { return `t${Date.now()}_${uid++}`; }

// 오늘이 기준일로부터 몇 주 지났는지 계산해 weeks.length로 나눈 나머지로
// "이번 주가 몇 주차인지" 판정한다. main.js의 computeCurrentWeekIndex와 동일한 로직.
function computeCurrentWeekIndex(duty, now) {
  if (!duty?.referenceDate || !duty.weeks?.length) return null;
  const ref = new Date(duty.referenceDate + 'T00:00:00');
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - ref) / 86400000);
  if (diffDays < 0) return null;
  const weekNum = Math.floor(diffDays / 7);
  return weekNum % duty.weeks.length;
}

// 관리자가 업무·주차·직원을 자유롭게 추가·수정·삭제할 수 있는 업무 로테이션
// 담당표. 담당자는 직원 목록에서 선택해서 지정하고(자유 입력 아님), 오늘 담당인
// 업무는 매일 자동으로 그 사람이 로그인했을 때만 보이는 "할일" 알람으로 등록된다.
export default function WeeklyDuty({ adminUnlocked }) {
  const [duty, setDuty] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [notice, setNotice] = useState(null);
  const [newStaffName, setNewStaffName] = useState('');
  const [openPicker, setOpenPicker] = useState(null); // "${section}_${taskId}_${weekIdx}" | null

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
      const alarmTime = prev.alarmTime || '09:00';
      if (section === 'monthlyTasks') {
        return { ...prev, monthlyTasks: [...prev.monthlyTasks, { id: newTaskId(), name: '', assignee: '', alarmTime }] };
      }
      return { ...prev, [section]: [...prev[section], { id: newTaskId(), name: '', alarmTime, assignments: prev.weeks.map(() => '') }] };
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
  function updateTaskAlarmTime(section, id, value) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, [section]: prev[section].map(t => t.id === id ? { ...t, alarmTime: value } : t) }));
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
  function updateSetting(patch) {
    if (!requireAdmin()) return;
    setDuty(prev => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function addStaff() {
    if (!requireAdmin()) return;
    const name = newStaffName.trim();
    if (!name) return;
    setDuty(prev => (prev.staff || []).includes(name) ? prev : { ...prev, staff: [...(prev.staff || []), name] });
    setNewStaffName('');
    setDirty(true);
  }
  function removeStaff(name) {
    if (!requireAdmin()) return;
    if (!confirm(`"${name}"님을 직원 목록에서 삭제하시겠습니까? 이미 배정된 담당자 표시는 그대로 남습니다.`)) return;
    setDuty(prev => ({ ...prev, staff: (prev.staff || []).filter(n => n !== name) }));
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
      showNotice('저장되었습니다. 오늘 담당자의 할일에도 반영했습니다.');
      syncAfterChange();
    } catch (e) {
      showNotice('저장 실패: ' + e.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncNow() {
    if (!requireAdmin()) return;
    setSyncingNow(true);
    try {
      const r = await syncWeeklyDutyTodosNow();
      if (r?.ok) showNotice('오늘의 할일에 반영했습니다.');
      else showNotice('반영 실패: ' + (r?.error || ''), true);
    } catch (e) {
      showNotice('반영 실패: ' + e.message, true);
    } finally {
      setSyncingNow(false);
    }
  }

  if (!duty) {
    return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  }

  const staff = duty.staff || [];
  const weekIdx = computeCurrentWeekIndex(duty, new Date());

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5" onClick={() => setOpenPicker(null)}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">주간근무</h1>
        {adminUnlocked && (
          <button onClick={e => { e.stopPropagation(); handleSave(); }} disabled={!dirty || saving}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400'} disabled:opacity-60`}>
            {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </button>
        )}
      </div>
      {!adminUnlocked && (
        <p className="text-xs text-gray-400">🔒 읽기 전용 — 담당자를 바꾸려면 관리자로 로그인하세요.</p>
      )}
      <p className="text-xs text-gray-400">
        담당자로 지정된 계정이 로그인했을 때만 그 사람의 "오늘의 할일"에 알람이 뜹니다.
      </p>

      {/* 설정 — 기준일·자동등록 여부, 이번 주 표시 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap items-center gap-x-5 gap-y-2" onClick={e => e.stopPropagation()}>
        <span className="text-sm font-semibold text-blue-600 whitespace-nowrap">
          {weekIdx == null ? '기준일 이후부터 자동 계산됩니다' : `📌 이번 주: ${duty.weeks[weekIdx] || `${weekIdx + 1}주차`}`}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          기준일(1주차 시작 월요일)
          <input type="date" value={duty.referenceDate || ''} disabled={!adminUnlocked}
            onChange={e => updateSetting({ referenceDate: e.target.value })}
            className="border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50 disabled:text-gray-400" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          새 업무 기본 알람 시각
          <input type="time" value={duty.alarmTime || '09:00'} disabled={!adminUnlocked}
            onChange={e => updateSetting({ alarmTime: e.target.value })}
            className="border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50 disabled:text-gray-400" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
          <input type="checkbox" checked={duty.autoAlarm !== false} disabled={!adminUnlocked}
            onChange={e => updateSetting({ autoAlarm: e.target.checked })} />
          오늘 담당자 할일에 자동 알람 등록
        </label>
        {adminUnlocked && (
          <button onClick={handleSyncNow} disabled={syncingNow}
            className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium disabled:opacity-50">
            {syncingNow ? '반영 중…' : '⏰ 오늘 할일 지금 반영'}
          </button>
        )}
      </div>

      {/* 직원 목록 — 담당자는 여기 등록된 이름 중에서 선택해서 배정한다 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4" onClick={e => e.stopPropagation()}>
        <p className="text-sm font-semibold text-gray-700 mb-2">👥 직원 목록</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {staff.map(n => (
            <span key={n} className="flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
              {n}
              {adminUnlocked && <button onClick={() => removeStaff(n)} className="text-gray-400 hover:text-red-500 leading-none">✕</button>}
            </span>
          ))}
          {staff.length === 0 && <span className="text-xs text-gray-300">등록된 직원이 없습니다.</span>}
        </div>
        {adminUnlocked && (
          <div className="flex gap-2">
            <input value={newStaffName} onChange={e => setNewStaffName(e.target.value)} placeholder="이름 입력" spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter') addStaff(); }}
              className="border border-gray-200 rounded px-2 py-1 text-sm flex-1 max-w-[160px]" />
            <button onClick={addStaff} className="text-xs px-3 py-1.5 bg-gray-800 text-white rounded-lg hover:bg-gray-700 font-medium">+ 추가</button>
          </div>
        )}
      </div>

      <DutyGrid title="📋 일일점검" section="dailyTasks" tasks={duty.dailyTasks} weeks={duty.weeks} staff={staff} adminUnlocked={adminUnlocked}
        openPicker={openPicker} setOpenPicker={setOpenPicker}
        onAddTask={() => addTask('dailyTasks')} onRemoveTask={id => removeTask('dailyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('dailyTasks', id, v)}
        onUpdateAlarmTime={(id, v) => updateTaskAlarmTime('dailyTasks', id, v)}
        onUpdateAssignment={(id, wi, v) => updateAssignment('dailyTasks', id, wi, v)}
        onUpdateWeekLabel={updateWeekLabel} onAddWeek={addWeek} onRemoveWeek={removeWeek} showWeekControls
      />

      <DutyGrid title="🗓 주간점검 (매주 월요일)" section="weeklyTasks" tasks={duty.weeklyTasks} weeks={duty.weeks} staff={staff} adminUnlocked={adminUnlocked}
        openPicker={openPicker} setOpenPicker={setOpenPicker}
        onAddTask={() => addTask('weeklyTasks')} onRemoveTask={id => removeTask('weeklyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('weeklyTasks', id, v)}
        onUpdateAlarmTime={(id, v) => updateTaskAlarmTime('weeklyTasks', id, v)}
        onUpdateAssignment={(id, wi, v) => updateAssignment('weeklyTasks', id, wi, v)}
        onUpdateWeekLabel={updateWeekLabel} onAddWeek={addWeek} onRemoveWeek={removeWeek} showWeekControls={false}
      />

      <MonthlySection duty={duty} staff={staff} adminUnlocked={adminUnlocked}
        onAddTask={() => addTask('monthlyTasks')} onRemoveTask={id => removeTask('monthlyTasks', id)}
        onUpdateName={(id, v) => updateTaskName('monthlyTasks', id, v)} onUpdateAssignee={updateMonthlyAssignee}
        onUpdateAlarmTime={(id, v) => updateTaskAlarmTime('monthlyTasks', id, v)}
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

// 담당자 셀 — 직원 목록 중에서 체크박스로 골라 배정한다(여러 명 가능, 쉼표로 저장).
// 드롭다운은 document.body에 포털로 그려서, 표를 감싼 가로 스크롤 영역(overflow-x)에
// 세로로 잘리거나 스크롤이 생기지 않게 한다.
function AssignCell({ pickerKey, value, staff, adminUnlocked, openPicker, setOpenPicker, onChange }) {
  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  const names = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const isOpen = openPicker === pickerKey;

  function toggleName(n) {
    const next = names.includes(n) ? names.filter(x => x !== n) : [...names, n];
    onChange(next.join(', '));
  }
  function handleToggleOpen(e) {
    e.stopPropagation();
    if (isOpen) { setOpenPicker(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left + r.width / 2 });
    setOpenPicker(pickerKey);
  }

  return (
    <div className="relative">
      <button ref={btnRef} type="button" disabled={!adminUnlocked} onClick={handleToggleOpen}
        className={`w-full text-center text-sm truncate ${names.length ? 'text-gray-700' : 'text-gray-300'} disabled:cursor-default`}
        title={names.join(', ') || undefined}>
        {names.length ? names.join(', ') : (adminUnlocked ? '선택' : '—')}
      </button>
      {isOpen && adminUnlocked && pos && createPortal(
        <div className="fixed z-[500] bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-40 max-h-52 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
          onClick={e => e.stopPropagation()}>
          {staff.length === 0 ? (
            <p className="text-xs text-gray-400 px-1 py-1">등록된 직원이 없습니다.</p>
          ) : staff.map(n => (
            <label key={n} className="flex items-center gap-1.5 text-xs text-gray-600 px-1 py-1 hover:bg-gray-50 rounded cursor-pointer select-none">
              <input type="checkbox" checked={names.includes(n)} onChange={() => toggleName(n)} />
              {n}
            </label>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// 업무 × 주차 배정표 — 일일점검·주간점검 둘 다 이 구조를 쓴다. 주차 열(weeks)은
// 두 표가 공유하므로, 열 추가/삭제 버튼은 showWeekControls가 true인 표에서만 보여준다.
function DutyGrid({ title, section, tasks, weeks, staff, adminUnlocked, openPicker, setOpenPicker, onAddTask, onRemoveTask, onUpdateName, onUpdateAlarmTime, onUpdateAssignment, onUpdateWeekLabel, onAddWeek, onRemoveWeek, showWeekControls }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden" onClick={e => e.stopPropagation()}>
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
              <th className="px-3 py-2 text-left text-gray-500 font-medium min-w-[200px]">업무</th>
              <th className="px-2 py-2 text-center text-gray-500 font-medium min-w-[90px]">⏰ 알람</th>
              {weeks.map((w, wi) => (
                <th key={wi} className="px-2 py-2 text-center text-gray-500 font-medium min-w-[110px]">
                  <div className="flex items-center justify-center gap-1">
                    <input value={w} disabled={!adminUnlocked} spellCheck={false} onChange={e => onUpdateWeekLabel(wi, e.target.value)}
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
                  <input value={t.name} disabled={!adminUnlocked} spellCheck={false} onChange={e => onUpdateName(t.id, e.target.value)}
                    className="w-full bg-transparent outline-none text-gray-800 disabled:text-gray-700" placeholder="업무명" />
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="time" value={t.alarmTime || ''} disabled={!adminUnlocked} onChange={e => onUpdateAlarmTime(t.id, e.target.value)}
                    className="w-full bg-transparent outline-none text-xs text-gray-600 disabled:text-gray-400" />
                </td>
                {weeks.map((_, wi) => (
                  <td key={wi} className="px-2 py-2 text-center">
                    <AssignCell pickerKey={`${section}_${t.id}_${wi}`} value={t.assignments[wi]} staff={staff}
                      adminUnlocked={adminUnlocked} openPicker={openPicker} setOpenPicker={setOpenPicker}
                      onChange={v => onUpdateAssignment(t.id, wi, v)} />
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
              <tr><td colSpan={weeks.length + 3} className="px-3 py-6 text-center text-gray-400 text-sm">등록된 업무가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 월간점검 — 항목마다 담당자 한 명(주차 개념 없음)이라 표 구조가 달라 별도로 그린다.
function MonthlySection({ duty, staff, adminUnlocked, onAddTask, onRemoveTask, onUpdateName, onUpdateAssignee, onUpdateAlarmTime }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="font-semibold text-gray-800 text-sm">📅 월간점검 (매월 1일, 말일)</span>
        {adminUnlocked && (
          <button onClick={onAddTask} className="text-xs px-2 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded font-medium">+ 항목 추가</button>
        )}
      </div>
      <div className="divide-y divide-gray-50">
        {duty.monthlyTasks.map(t => (
          <div key={t.id} className="flex items-center gap-3 px-5 py-2.5">
            <input value={t.name} disabled={!adminUnlocked} spellCheck={false} onChange={e => onUpdateName(t.id, e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm text-gray-800 disabled:text-gray-700" placeholder="점검 항목" />
            <input type="time" value={t.alarmTime || ''} disabled={!adminUnlocked} onChange={e => onUpdateAlarmTime(t.id, e.target.value)}
              className="w-24 text-center bg-transparent outline-none text-xs text-gray-600 disabled:text-gray-400 border-l border-gray-100 pl-3" />
            <select value={t.assignee || ''} disabled={!adminUnlocked} onChange={e => onUpdateAssignee(t.id, e.target.value)}
              className="w-32 text-center bg-transparent outline-none text-sm text-gray-600 disabled:text-gray-500 border-l border-gray-100 pl-3">
              <option value="">선택</option>
              {staff.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
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
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden" onClick={e => e.stopPropagation()}>
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="font-semibold text-gray-800 text-sm">📝 분기점검, 해야할일, 특이사항 및 기타</span>
      </div>
      <div className="p-4">
        <textarea value={notes || ''} disabled={!adminUnlocked} spellCheck={false} onChange={e => onChange(e.target.value)}
          rows={5} placeholder="분기점검 계획, 해야 할 일, 특이사항 등을 자유롭게 적어두세요."
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-50 disabled:text-gray-500" />
      </div>
    </div>
  );
}
