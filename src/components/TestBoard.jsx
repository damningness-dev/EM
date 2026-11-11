import { useState, useEffect, useRef } from 'react';
import { fetchWeeklyDuty, fetchWeeklyBoard, saveWeeklyBoard, syncAfterChange } from '../lib/api';

// TEST 메뉴 — 업무 배치판. 기존 "주간근무" 메뉴는 그대로 두고, 같은 직원 목록을 가로 칸으로 펼친 뒤
// 업무 버튼을 끌어다(드래그 앤 드롭) 근무자에게 배치한다. 나중에 주간근무와 합치거나 바꿀 수 있도록
// 배치 내용은 따로(weeklyBoard) 저장한다. 수정은 관리자만 할 수 있고, 나머지 계정은 보기만 한다.
//   board = { tasks: [{ id, name }], assignments: { '<직원>': ['<업무 id>', ...] } }

const COLORS = [
  'bg-blue-100 text-blue-800 border-blue-300', 'bg-emerald-100 text-emerald-800 border-emerald-300',
  'bg-amber-100 text-amber-800 border-amber-300', 'bg-purple-100 text-purple-800 border-purple-300',
  'bg-rose-100 text-rose-800 border-rose-300', 'bg-cyan-100 text-cyan-800 border-cyan-300',
  'bg-lime-100 text-lime-800 border-lime-300', 'bg-orange-100 text-orange-800 border-orange-300',
];
const colorOf = (tasks, id) => COLORS[Math.max(0, tasks.findIndex(t => t.id === id)) % COLORS.length];
let uid = 0;
const newTaskId = () => `bt${Date.now()}_${uid++}`;

export default function TestBoard({ adminUnlocked }) {
  const [staff, setStaff] = useState(null);
  const [board, setBoard] = useState({ tasks: [], assignments: {} });
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [overCol, setOverCol] = useState(null);   // 드래그 중 올려둔 근무자 칸
  const [overPalette, setOverPalette] = useState(false);
  const [notice, setNotice] = useState(null);
  const saveTimer = useRef(null);

  function load() {
    fetchWeeklyDuty().then(d => setStaff(Array.isArray(d?.staff) ? d.staff : [])).catch(() => setStaff([]));
    fetchWeeklyBoard().then(b => setBoard({ tasks: b?.tasks || [], assignments: b?.assignments || {} })).catch(() => {});
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => load());
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

  function addTask() {
    const name = newName.trim();
    if (!name || !guard()) return;
    commit({ ...board, tasks: [...board.tasks, { id: newTaskId(), name }] });
    setNewName('');
  }
  function removeTask(id) {
    if (!guard()) return;
    if (!confirm('이 업무 버튼을 삭제할까요? 근무자에게 배치된 것도 함께 사라집니다.')) return;
    const assignments = {};
    Object.entries(board.assignments).forEach(([who, ids]) => { assignments[who] = ids.filter(x => x !== id); });
    commit({ tasks: board.tasks.filter(t => t.id !== id), assignments });
  }
  function renameTask(id, name) {
    setEditingId(null);
    const n = name.trim();
    if (!n || !guard()) return;
    commit({ ...board, tasks: board.tasks.map(t => t.id === id ? { ...t, name: n } : t) });
  }

  // ── 드래그 앤 드롭 ──
  // 업무 버튼(palette)을 칸에 놓으면 그 근무자에게 배치(같은 업무를 여러 명에게도 가능),
  // 배치된 칩(placed)을 다른 칸에 놓으면 이동, 업무 목록 영역에 놓으면 배치 해제.
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
    if (d.kind === 'placed' && d.from) assignments[d.from] = (assignments[d.from] || []).filter(x => x !== d.taskId);
    const cur = assignments[who] || [];
    assignments[who] = cur.includes(d.taskId) ? cur : [...cur, d.taskId];
    commit({ ...board, assignments });
  }
  function dropOnPalette(e) {
    e.preventDefault(); setOverPalette(false);
    const d = readDrag(e);
    if (d?.kind !== 'placed' || !d.from || !guard()) return;
    commit({ ...board, assignments: { ...board.assignments, [d.from]: (board.assignments[d.from] || []).filter(x => x !== d.taskId) } });
  }
  function unassign(who, taskId) {
    if (!guard()) return;
    commit({ ...board, assignments: { ...board.assignments, [who]: (board.assignments[who] || []).filter(x => x !== taskId) } });
  }

  if (staff === null) return <div className="p-6 text-sm text-gray-400">불러오는 중...</div>;
  const taskById = new Map(board.tasks.map(t => [t.id, t]));
  const countOf = (id) => staff.filter(w => (board.assignments[w] || []).includes(id)).length;

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-800">TEST <span className="text-base font-medium text-gray-400">업무 배치</span></h1>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">시험용</span>
        {!adminUnlocked && <span className="text-xs text-gray-400">🔒 보기 전용 — 관리자로 로그인하면 업무를 배치할 수 있습니다</span>}
        {notice && <span className={`text-xs font-medium ${notice.isError ? 'text-red-500' : 'text-green-600'}`}>{notice.text}</span>}
      </div>
      <p className="text-xs text-gray-400 mb-4">
        기존 "주간근무" 메뉴는 그대로 두었습니다. 직원 목록은 주간근무의 직원을 그대로 쓰고, 아래 업무 버튼을 근무자 칸으로 끌어다 놓아 배치하세요.
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
              <span className="text-[11px] text-gray-400">버튼을 끌어서 아래 근무자 칸에 놓으세요 · 배치된 칩을 이 영역에 놓으면 배치가 해제됩니다</span>
            </>
          )}
        </div>
        {board.tasks.length === 0 ? (
          <p className="text-sm text-gray-300 py-2">{adminUnlocked ? '업무 버튼이 없습니다. 위에서 업무를 추가하세요.' : '등록된 업무가 없습니다.'}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {board.tasks.map(t => (
              <div key={t.id}
                draggable={adminUnlocked && editingId !== t.id}
                onDragStart={e => startDrag(e, { kind: 'palette', taskId: t.id })}
                onDoubleClick={() => { if (adminUnlocked) { setEditingId(t.id); setEditingName(t.name); } }}
                className={`group inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg border text-sm font-medium select-none shadow-sm ${colorOf(board.tasks, t.id)} ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}
                title={adminUnlocked ? '끌어서 근무자에게 배치 · 더블클릭으로 이름 수정' : t.name}>
                {editingId === t.id ? (
                  <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)}
                    onBlur={() => renameTask(t.id, editingName)}
                    onKeyDown={e => { if (e.key === 'Enter') renameTask(t.id, editingName); if (e.key === 'Escape') setEditingId(null); }}
                    className="bg-white/80 border border-gray-300 rounded px-1 text-sm w-44 text-gray-800" />
                ) : <span>{t.name}</span>}
                {countOf(t.id) > 0 && <span className="text-[10px] px-1 rounded bg-white/70 text-gray-600" title="배치된 근무자 수">×{countOf(t.id)}</span>}
                {adminUnlocked && <button onClick={() => removeTask(t.id)} className="text-gray-400 hover:text-red-500 text-xs leading-none px-0.5" title="업무 버튼 삭제">✕</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 근무자 칸 — 인원수만큼 가로로 */}
      {staff.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">직원이 없습니다. "주간근무" 메뉴의 직원 목록에서 직원을 먼저 추가하세요.</p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${staff.length}, minmax(200px, 1fr))` }}>
            {staff.map(who => {
              const ids = (board.assignments[who] || []).filter(id => taskById.has(id));
              const over = overCol === who;
              return (
                <div key={who}
                  onDragOver={e => { if (adminUnlocked) { e.preventDefault(); setOverCol(who); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null); }}
                  onDrop={e => dropOnStaff(e, who)}
                  className={`rounded-xl border-2 min-h-[260px] flex flex-col transition-colors ${over ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-gray-50/60'}`}>
                  <div className="px-3 py-2.5 border-b border-gray-200 bg-white rounded-t-[10px] flex items-center justify-between">
                    <span className="font-semibold text-gray-800">👤 {who}</span>
                    <span className="text-xs text-gray-400">{ids.length}건</span>
                  </div>
                  <div className="p-2.5 space-y-1.5 flex-1">
                    {ids.length === 0 && <p className="text-xs text-gray-300 text-center py-8">{adminUnlocked ? '여기에 업무를 끌어다 놓으세요' : '배치된 업무 없음'}</p>}
                    {ids.map(id => {
                      const t = taskById.get(id);
                      return (
                        <div key={id}
                          draggable={adminUnlocked}
                          onDragStart={e => startDrag(e, { kind: 'placed', taskId: id, from: who })}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-sm font-medium shadow-sm ${colorOf(board.tasks, id)} ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                          <span className="flex-1 break-words">{t.name}</span>
                          {adminUnlocked && <button onClick={() => unassign(who, id)} className="text-gray-400 hover:text-red-500 text-xs leading-none" title="배치 해제">✕</button>}
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
