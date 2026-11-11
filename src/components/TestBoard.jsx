import { useState, useEffect, useRef } from 'react';
import { fetchWeeklyDuty, fetchWeeklyBoard, saveWeeklyBoard, syncAfterChange } from '../lib/api';

// TEST 메뉴 — 업무 배치판. 기존 "주간근무" 메뉴는 그대로 두고, 같은 직원 목록을 가로 칸으로 펼친 뒤
// 업무 버튼을 끌어다(드래그 앤 드롭) 근무자에게 배치한다. 배치된 업무마다 기한과 진행상태를 입력하고,
// 근무자마다 색이 달라 누구 업무인지 한눈에 보인다. 나중에 주간근무와 합치거나 바꿀 수 있도록
// 배치 내용은 따로(weeklyBoard) 저장한다. 수정은 관리자만 할 수 있고, 나머지 계정은 보기만 한다.
//   board = { tasks: [{ id, name, kind }], assignments: { '<직원>': [taskId] },
//             progress: { '<직원>': { '<taskId>': { due, status } } } }

// 근무자별 색(Tailwind가 클래스를 찾을 수 있게 전체 이름으로 적는다)
const WORKER_COLORS = [
  { head: 'bg-blue-600 text-white',    col: 'border-blue-300 bg-blue-50/60',       chip: 'bg-blue-100 border-blue-400 text-blue-900',       dot: 'bg-blue-500',    over: 'border-blue-600 bg-blue-100' },
  { head: 'bg-emerald-600 text-white', col: 'border-emerald-300 bg-emerald-50/60', chip: 'bg-emerald-100 border-emerald-400 text-emerald-900', dot: 'bg-emerald-500', over: 'border-emerald-600 bg-emerald-100' },
  { head: 'bg-amber-500 text-white',   col: 'border-amber-300 bg-amber-50/60',     chip: 'bg-amber-100 border-amber-400 text-amber-900',     dot: 'bg-amber-500',   over: 'border-amber-600 bg-amber-100' },
  { head: 'bg-purple-600 text-white',  col: 'border-purple-300 bg-purple-50/60',   chip: 'bg-purple-100 border-purple-400 text-purple-900',  dot: 'bg-purple-500',  over: 'border-purple-600 bg-purple-100' },
  { head: 'bg-rose-600 text-white',    col: 'border-rose-300 bg-rose-50/60',       chip: 'bg-rose-100 border-rose-400 text-rose-900',        dot: 'bg-rose-500',    over: 'border-rose-600 bg-rose-100' },
  { head: 'bg-cyan-600 text-white',    col: 'border-cyan-300 bg-cyan-50/60',       chip: 'bg-cyan-100 border-cyan-400 text-cyan-900',        dot: 'bg-cyan-500',    over: 'border-cyan-600 bg-cyan-100' },
  { head: 'bg-lime-600 text-white',    col: 'border-lime-300 bg-lime-50/60',       chip: 'bg-lime-100 border-lime-400 text-lime-900',        dot: 'bg-lime-500',    over: 'border-lime-600 bg-lime-100' },
  { head: 'bg-orange-600 text-white',  col: 'border-orange-300 bg-orange-50/60',   chip: 'bg-orange-100 border-orange-400 text-orange-900',  dot: 'bg-orange-500',  over: 'border-orange-600 bg-orange-100' },
];
const KIND_LABEL = { daily: '매일', weekly: '주간', monthly: '월간', '': '직접 추가' };
const KIND_ORDER = ['daily', 'weekly', 'monthly', ''];
const STATUS = [['todo', '대기'], ['doing', '진행중'], ['done', '완료']];
const STATUS_CLS = { todo: 'bg-white text-gray-500 border-gray-300', doing: 'bg-blue-600 text-white border-blue-600', done: 'bg-green-600 text-white border-green-600' };
let uid = 0;
const newTaskId = () => `bt${Date.now()}_${uid++}`;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 주간근무에 있는 업무(매일·주간·월간)를 업무 버튼 형태로 바꾼다. 아이디는 wd_<원래 업무 id>라
// 여러 번 가져와도 같은 업무는 같은 아이디로 중복되지 않는다. 담당자 배정은 가져오지 않는다.
function dutyTasksOf(duty) {
  if (!duty) return [];
  const pick = (list, kind) => (Array.isArray(list) ? list : []).filter(t => t?.id && String(t.name || '').trim())
    .map(t => ({ id: `wd_${t.id}`, name: String(t.name).trim(), kind }));
  return [...pick(duty.dailyTasks, 'daily'), ...pick(duty.weeklyTasks, 'weekly'), ...pick(duty.monthlyTasks, 'monthly')];
}

function dueLabel(due, status) {
  if (!due) return null;
  if (status === 'done') return { text: due.slice(5).replace('-', '/'), cls: 'text-gray-400' };
  const diff = Math.round((new Date(due + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
  if (diff < 0) return { text: `기한 ${-diff}일 지남`, cls: 'text-red-600 font-semibold' };
  if (diff === 0) return { text: '오늘 마감', cls: 'text-red-600 font-semibold' };
  if (diff <= 3) return { text: `D-${diff}`, cls: 'text-orange-600 font-semibold' };
  return { text: `D-${diff}`, cls: 'text-gray-500' };
}

export default function TestBoard({ adminUnlocked }) {
  const [staff, setStaff] = useState(null);
  const [duty, setDuty] = useState(null);
  const [board, setBoard] = useState({ tasks: [], assignments: {}, progress: {} });
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [overCol, setOverCol] = useState(null);
  const [overPalette, setOverPalette] = useState(false);
  const [notice, setNotice] = useState(null);
  const saveTimer = useRef(null);
  const seeded = useRef(false);

  const adminRef = useRef(adminUnlocked);
  useEffect(() => { adminRef.current = adminUnlocked; }, [adminUnlocked]);
  function load() {
    Promise.all([fetchWeeklyDuty().catch(() => null), fetchWeeklyBoard().catch(() => null)]).then(([d, b]) => {
      setDuty(d || null);
      setStaff(Array.isArray(d?.staff) ? d.staff : []);
      const loadedBoard = { tasks: b?.tasks || [], assignments: b?.assignments || {}, progress: b?.progress || {} };
      // 처음 열었는데 업무 버튼이 하나도 없으면(관리자) 주간근무 업무를 자동으로 채워 저장한다.
      if (!seeded.current && adminRef.current && loadedBoard.tasks.length === 0 && dutyTasksOf(d).length > 0) {
        seeded.current = true;
        commit({ ...loadedBoard, tasks: dutyTasksOf(d) });
      } else {
        setBoard(loadedBoard);
      }
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  function flash(text, isError) { setNotice({ text, isError }); setTimeout(() => setNotice(null), 2500); }

  // 바뀔 때마다 잠깐 모았다가 한 번에 저장·공유한다.
  function commit(next) {
    setBoard(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const r = await saveWeeklyBoard(next);
        if (r && r.ok === false) { flash(r.error || '저장 실패', true); load(); return; }
        syncAfterChange();
      } catch (e) { flash('저장 실패: ' + e.message, true); }
    }, 500);
  }
  function guard() { if (!adminUnlocked) { flash('관리자로 로그인해야 수정할 수 있습니다.', true); return false; } return true; }

  // "주간근무 업무 가져오기" — 아직 가져오지 않은 업무만 추가한다.
  function importFromDuty() {
    const have = new Set(board.tasks.map(t => t.id));
    const add = dutyTasksOf(duty).filter(t => !have.has(t.id));
    if (add.length === 0) { flash('가져올 새 업무가 없습니다.'); return; }
    commit({ ...board, tasks: [...board.tasks, ...add] });
    flash(`주간근무 업무 ${add.length}개를 가져왔습니다.`);
  }

  function addTask() {
    const name = newName.trim();
    if (!name || !guard()) return;
    commit({ ...board, tasks: [...board.tasks, { id: newTaskId(), name, kind: '' }] });
    setNewName('');
  }
  function removeTask(id) {
    if (!guard()) return;
    if (!confirm('이 업무 버튼을 삭제할까요? 근무자에게 배치된 것과 기한·진행상태도 함께 사라집니다.')) return;
    const assignments = {}, progress = {};
    Object.entries(board.assignments).forEach(([who, ids]) => { assignments[who] = ids.filter(x => x !== id); });
    Object.entries(board.progress).forEach(([who, per]) => { const { [id]: _drop, ...rest } = per || {}; progress[who] = rest; }); // eslint-disable-line no-unused-vars
    commit({ tasks: board.tasks.filter(t => t.id !== id), assignments, progress });
  }
  function renameTask(id, name) {
    setEditingId(null);
    const n = name.trim();
    if (!n || !guard()) return;
    commit({ ...board, tasks: board.tasks.map(t => t.id === id ? { ...t, name: n } : t) });
  }
  function setProgress(who, taskId, patch) {
    if (!guard()) return;
    const cur = (board.progress[who] || {})[taskId] || { due: '', status: 'todo' };
    commit({ ...board, progress: { ...board.progress, [who]: { ...(board.progress[who] || {}), [taskId]: { ...cur, ...patch } } } });
  }

  // ── 드래그 앤 드롭 ──
  // 업무 버튼(palette)을 칸에 놓으면 그 근무자에게 배치(같은 업무를 여러 명에게도 가능),
  // 배치된 칩(placed)을 다른 칸에 놓으면 기한·진행상태와 함께 이동, 업무 영역에 놓으면 배치 해제.
  function startDrag(e, payload) {
    if (!adminUnlocked) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
  }
  function readDrag(e) { try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; } }
  function dropOnStaff(e, who) {
    e.preventDefault(); setOverCol(null);
    const d = readDrag(e);
    if (!d?.taskId || !guard()) return;
    const assignments = { ...board.assignments };
    const progress = { ...board.progress };
    if (d.kind === 'placed' && d.from && d.from !== who) {
      assignments[d.from] = (assignments[d.from] || []).filter(x => x !== d.taskId);
      const moved = (progress[d.from] || {})[d.taskId];
      if (moved) {
        const { [d.taskId]: _drop, ...rest } = progress[d.from]; // eslint-disable-line no-unused-vars
        progress[d.from] = rest;
        if (!(progress[who] || {})[d.taskId]) progress[who] = { ...(progress[who] || {}), [d.taskId]: moved };
      }
    }
    const cur = assignments[who] || [];
    assignments[who] = cur.includes(d.taskId) ? cur : [...cur, d.taskId];
    commit({ ...board, assignments, progress });
  }
  function dropOnPalette(e) {
    e.preventDefault(); setOverPalette(false);
    const d = readDrag(e);
    if (d?.kind !== 'placed' || !d.from) return;
    unassign(d.from, d.taskId);
  }
  function unassign(who, taskId) {
    if (!guard()) return;
    const { [taskId]: _drop, ...rest } = board.progress[who] || {}; // eslint-disable-line no-unused-vars
    commit({ ...board, assignments: { ...board.assignments, [who]: (board.assignments[who] || []).filter(x => x !== taskId) }, progress: { ...board.progress, [who]: rest } });
  }

  if (staff === null) return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  const taskById = new Map(board.tasks.map(t => [t.id, t]));
  const colorOf = (who) => WORKER_COLORS[Math.max(0, staff.indexOf(who)) % WORKER_COLORS.length];
  const workersOf = (id) => staff.filter(w => (board.assignments[w] || []).includes(id));
  const groups = KIND_ORDER.map(k => ({ kind: k, tasks: board.tasks.filter(t => (t.kind || '') === k) })).filter(g => g.tasks.length > 0);
  const canImport = dutyTasksOf(duty).some(t => !taskById.has(t.id));

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-800">TEST <span className="text-base font-medium text-gray-400">업무 배치</span></h1>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">시험용</span>
        {!adminUnlocked && <span className="text-xs text-gray-400">🔒 보기 전용 — 관리자로 로그인하면 업무를 배치할 수 있습니다</span>}
        {notice && <span className={`text-xs font-medium ${notice.isError ? 'text-red-500' : 'text-green-600'}`}>{notice.text}</span>}
      </div>
      <p className="text-xs text-gray-400 mb-4">
        기존 "주간근무" 메뉴는 그대로 두었습니다. 직원 목록과 업무는 주간근무에서 가져온 것이고, 업무 버튼을 근무자 칸으로 끌어다 놓아 배치한 뒤 기한·진행상태를 입력하세요.
      </p>

      {/* 업무 버튼 */}
      <div
        onDragOver={e => { if (adminUnlocked) { e.preventDefault(); setOverPalette(true); } }}
        onDragLeave={() => setOverPalette(false)}
        onDrop={dropOnPalette}
        className={`rounded-xl border bg-white p-4 mb-5 transition-colors ${overPalette ? 'border-red-300 bg-red-50/40' : 'border-gray-200'}`}
      >
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-700">📋 업무</span>
          {adminUnlocked && (
            <>
              <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTask(); }}
                placeholder="업무 이름 입력 후 Enter" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-400" />
              <button onClick={addTask} disabled={!newName.trim()}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">+ 업무 추가</button>
              {canImport && (
                <button onClick={importFromDuty} className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
                  title="주간근무의 매일·주간·월간 업무 중 아직 가져오지 않은 것을 업무 버튼으로 추가합니다">📥 주간근무 업무 가져오기</button>
              )}
              <span className="text-[11px] text-gray-400">버튼을 끌어서 근무자 칸에 놓으세요 · 배치된 칩을 이 영역에 놓으면 배치가 해제됩니다</span>
            </>
          )}
        </div>
        {board.tasks.length === 0 ? (
          <p className="text-sm text-gray-300 py-2">{adminUnlocked ? '업무 버튼이 없습니다. 위에서 업무를 추가하거나 주간근무 업무를 가져오세요.' : '등록된 업무가 없습니다.'}</p>
        ) : (
          <div className="space-y-2.5">
            {groups.map(g => (
              <div key={g.kind || 'etc'} className="flex items-start gap-2">
                <span className="shrink-0 w-14 text-[11px] font-semibold text-gray-400 pt-2">{KIND_LABEL[g.kind]}</span>
                <div className="flex flex-wrap gap-2">
                  {g.tasks.map(t => {
                    const ws = workersOf(t.id);
                    return (
                      <div key={t.id}
                        draggable={adminUnlocked && editingId !== t.id}
                        onDragStart={e => startDrag(e, { kind: 'palette', taskId: t.id })}
                        onDoubleClick={() => { if (adminUnlocked) { setEditingId(t.id); setEditingName(t.name); } }}
                        className={`inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg border border-gray-300 bg-gray-50 text-sm font-medium text-gray-700 select-none shadow-sm ${adminUnlocked ? 'cursor-grab active:cursor-grabbing hover:bg-white' : ''}`}
                        title={adminUnlocked ? '끌어서 근무자에게 배치 · 더블클릭으로 이름 수정' : t.name}>
                        {editingId === t.id ? (
                          <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)}
                            onBlur={() => renameTask(t.id, editingName)}
                            onKeyDown={e => { if (e.key === 'Enter') renameTask(t.id, editingName); if (e.key === 'Escape') setEditingId(null); }}
                            className="bg-white border border-gray-300 rounded px-1 text-sm w-44 text-gray-800" />
                        ) : <span>{t.name}</span>}
                        {/* 배치된 근무자를 그 사람의 색 점으로 표시 */}
                        {ws.length > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={`배치: ${ws.join(', ')}`}>
                            {ws.map(w => <span key={w} className={`w-2.5 h-2.5 rounded-full ${colorOf(w).dot}`} />)}
                          </span>
                        )}
                        {adminUnlocked && <button onClick={() => removeTask(t.id)} className="text-gray-400 hover:text-red-500 text-xs leading-none px-0.5" title="업무 버튼 삭제">✕</button>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 근무자 칸 — 인원수만큼 가로로, 사람마다 다른 색 */}
      {staff.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">직원이 없습니다. "주간근무" 메뉴의 직원 목록에서 직원을 먼저 추가하세요.</p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${staff.length}, minmax(240px, 1fr))` }}>
            {staff.map(who => {
              const c = colorOf(who);
              const ids = (board.assignments[who] || []).filter(id => taskById.has(id));
              const doneCnt = ids.filter(id => (board.progress[who] || {})[id]?.status === 'done').length;
              const over = overCol === who;
              return (
                <div key={who}
                  onDragOver={e => { if (adminUnlocked) { e.preventDefault(); setOverCol(who); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null); }}
                  onDrop={e => dropOnStaff(e, who)}
                  className={`rounded-xl border-2 min-h-[260px] flex flex-col transition-colors ${over ? c.over : c.col}`}>
                  <div className={`px-3 py-2.5 rounded-t-[10px] flex items-center justify-between ${c.head}`}>
                    <span className="font-semibold">👤 {who}</span>
                    <span className="text-xs opacity-90">{ids.length ? `${doneCnt}/${ids.length} 완료` : '0건'}</span>
                  </div>
                  <div className="p-2.5 space-y-2 flex-1">
                    {ids.length === 0 && <p className="text-xs text-gray-400 text-center py-8">{adminUnlocked ? '여기에 업무를 끌어다 놓으세요' : '배치된 업무 없음'}</p>}
                    {ids.map(id => {
                      const t = taskById.get(id);
                      const pr = (board.progress[who] || {})[id] || { due: '', status: 'todo' };
                      const dl = dueLabel(pr.due, pr.status);
                      return (
                        <div key={id}
                          draggable={adminUnlocked}
                          onDragStart={e => startDrag(e, { kind: 'placed', taskId: id, from: who })}
                          className={`rounded-lg border px-2.5 py-2 shadow-sm ${c.chip} ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                          <div className="flex items-start gap-1">
                            <span className={`flex-1 text-sm font-medium break-words ${pr.status === 'done' ? 'line-through opacity-60' : ''}`}>{t.name}</span>
                            {adminUnlocked && <button onClick={() => unassign(who, id)} className="text-gray-400 hover:text-red-500 text-xs leading-none" title="배치 해제">✕</button>}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            {adminUnlocked ? (
                              <select value={pr.status} onChange={e => setProgress(who, id, { status: e.target.value })}
                                onMouseDown={e => e.stopPropagation()} draggable={false}
                                className={`text-[11px] font-semibold rounded border px-1 py-0.5 cursor-pointer ${STATUS_CLS[pr.status]}`}>
                                {STATUS.map(([v, l]) => <option key={v} value={v} className="bg-white text-gray-800">{l}</option>)}
                              </select>
                            ) : (
                              <span className={`text-[11px] font-semibold rounded border px-1.5 py-0.5 ${STATUS_CLS[pr.status]}`}>{STATUS.find(s => s[0] === pr.status)?.[1]}</span>
                            )}
                            {adminUnlocked ? (
                              <input type="date" value={pr.due} onChange={e => setProgress(who, id, { due: e.target.value })}
                                onMouseDown={e => e.stopPropagation()} draggable={false} title="기한"
                                className="text-[11px] rounded border border-gray-300 bg-white/80 px-1 py-0.5 text-gray-700" />
                            ) : pr.due ? <span className="text-[11px] text-gray-600">기한 {pr.due}</span> : null}
                            {dl && <span className={`text-[10px] ${dl.cls}`}>{dl.text}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
