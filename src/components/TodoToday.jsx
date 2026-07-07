import { useState, useEffect } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, fetchTodos, upsertTodo, deleteTodo, toggleTodoDone } from '../lib/api';
import { parseISO, differenceInDays } from 'date-fns';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const REPEAT_OPTIONS = [
  { value: 'none', label: '반복없음' },
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주' },
  { value: 'monthly', label: '매월' },
  { value: 'yearly', label: '매년' },
];
const REPEAT_LABEL = { none: '', daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' };

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return fmtDate(new Date()); }
// 마감기한 D-day (날짜만 비교)
function dueDday(dueStr) {
  const due = new Date(dueStr + 'T00:00:00');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((due - t) / 86400000);
}
// 뷰(일간/주간/월간)에 표시할 날짜 배열
function rangeDates(view) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  if (view === 'week') {
    const dow = (t.getDay() + 6) % 7; // 월=0
    const start = new Date(t); start.setDate(t.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }
  if (view === 'month') {
    const y = t.getFullYear(), m = t.getMonth();
    const n = new Date(y, m + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => new Date(y, m, i + 1));
  }
  return [t]; // day
}

// todo가 특정 날짜에 발생하는지 (반복주기 반영) — main.js와 동일 로직
function todoOccursOn(todo, dateStr) {
  if (!todo.date || dateStr < todo.date) return false;
  const repeat = todo.repeat || 'none';
  if (repeat === 'none') return dateStr === todo.date;
  const base = new Date(todo.date + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const interval = Math.max(1, todo.interval || 1);
  const dayDiff = Math.round((d - base) / 86400000);
  if (repeat === 'daily') return dayDiff >= 0 && dayDiff % interval === 0;
  if (repeat === 'weekly') return dayDiff >= 0 && dayDiff % (7 * interval) === 0;
  if (repeat === 'monthly') {
    if (d.getDate() !== base.getDate()) return false;
    const m = (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
    return m >= 0 && m % interval === 0;
  }
  if (repeat === 'yearly') {
    if (d.getDate() !== base.getDate() || d.getMonth() !== base.getMonth()) return false;
    const y = d.getFullYear() - base.getFullYear();
    return y >= 0 && y % interval === 0;
  }
  return false;
}

function dDay(dateStr) {
  if (!dateStr) return null;
  return differenceInDays(parseISO(dateStr), new Date());
}

function DayBadge({ days }) {
  if (days === null) return null;
  if (days < 0) return <span className="text-xs font-bold text-red-600">만료 {Math.abs(days)}일 경과</span>;
  if (days === 0) return <span className="text-xs font-bold text-red-600">D-Day</span>;
  return <span className={`text-xs font-bold ${days <= 7 ? 'text-orange-600' : days <= 30 ? 'text-yellow-600' : 'text-gray-400'}`}>D-{days}</span>;
}

function Section({ title, icon, count, countColor, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50">
        <span className="text-base">{icon}</span>
        <span className="font-semibold text-gray-800 text-sm">{title}</span>
        {count !== undefined && (
          <span className={`ml-auto text-sm font-bold ${countColor || 'text-gray-600'}`}>{count}</span>
        )}
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}

export default function TodoToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const dow = DOW[today.getDay()];

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);

  // 할일(반복 일정)
  const [todos, setTodos] = useState([]);
  const [showTodoForm, setShowTodoForm] = useState(false);
  const [editingTodo, setEditingTodo] = useState(null); // 편집중 todo id
  const blankForm = { title: '', date: todayStr(), due: '', time: '', repeat: 'none', interval: 1, alarmEnabled: false, note: '' };
  const [todoForm, setTodoForm] = useState(blankForm);
  const [todoView, setTodoView] = useState('day'); // day | week | month

  useEffect(() => {
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
      fetchTodos().catch(() => []),
    ]).then(([cal, zns, mon, plan, tds]) => {
      setCalibration(cal);
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setTodos(tds || []);
      setLoading(false);
    });
  }, []);

  async function saveTodo() {
    const title = todoForm.title.trim();
    if (!title) return;
    const payload = {
      ...(editingTodo ? { ...todos.find(t => t.id === editingTodo) } : {}),
      title,
      date: todoForm.date || todayStr(),
      due: todoForm.due || '',
      time: todoForm.time || '',
      repeat: todoForm.repeat || 'none',
      interval: Math.max(1, parseInt(todoForm.interval) || 1),
      alarmEnabled: !!todoForm.alarmEnabled && !!todoForm.time,
      note: todoForm.note || '',
    };
    const saved = await upsertTodo(payload);
    setTodos(prev => {
      const i = prev.findIndex(t => t.id === saved.id);
      return i >= 0 ? prev.map(t => t.id === saved.id ? saved : t) : [...prev, saved];
    });
    window.electronAPI?.notifyDataChanged?.();
    setShowTodoForm(false);
    setEditingTodo(null);
    setTodoForm(blankForm);
  }

  async function handleToggleTodo(id, dateStr) {
    const saved = await toggleTodoDone(id, dateStr || todayStr());
    if (saved) setTodos(prev => prev.map(t => t.id === id ? saved : t));
    window.electronAPI?.notifyDataChanged?.();
  }

  async function handleDeleteTodo(id) {
    await deleteTodo(id);
    setTodos(prev => prev.filter(t => t.id !== id));
    window.electronAPI?.notifyDataChanged?.();
  }

  function startEditTodo(t) {
    setEditingTodo(t.id);
    setTodoForm({ title: t.title, date: t.date || todayStr(), due: t.due || '', time: t.time || '', repeat: t.repeat || 'none', interval: t.interval || 1, alarmEnabled: !!t.alarmEnabled, note: t.note || '' });
    setShowTodoForm(true);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 교정 항목 분류
  const overdueCalib = calibration
    .filter(c => c.next_calib_date && dDay(c.next_calib_date) < 0)
    .sort((a, b) => dDay(a.next_calib_date) - dDay(b.next_calib_date));

  const soonCalib = calibration
    .filter(c => c.next_calib_date && dDay(c.next_calib_date) >= 0 && dDay(c.next_calib_date) <= 60)
    .sort((a, b) => dDay(a.next_calib_date) - dDay(b.next_calib_date));

  // 모니터링 현황
  const completedZones = zones.filter(z => monitoring[z.id]);
  const pendingZones = zones.filter(z => !monitoring[z.id]);
  const monRate = zones.length ? Math.round(completedZones.length / zones.length * 100) : 0;

  // AHU 이번달 계획
  const ahuTasks = Object.entries(annualPlan)
    .filter(([key]) => {
      const parts = key.split('_');
      return parts[parts.length - 1] === String(month);
    })
    .map(([key, val]) => {
      const parts = key.split('_');
      parts.pop();
      return { ahuName: parts.join('_'), ...val };
    })
    .filter(t => t.planned)
    .sort((a, b) => a.ahuName.localeCompare(b.ahuName));

  const ahuDone = ahuTasks.filter(t => t.done).length;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      {/* 헤더 */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">오늘의 할일</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {year}년 {MONTH_KR[month - 1]} {today.getDate()}일 ({dow}요일)
          </p>
        </div>
        <button
          onClick={() => { setEditingTodo(null); setTodoForm(blankForm); setShowTodoForm(v => !v); }}
          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
        >+ 할일 추가</button>
      </div>

      {/* 할일 추가/편집 폼 */}
      {showTodoForm && (
        <div className="bg-white rounded-xl border border-blue-200 p-4 space-y-3">
          <input
            autoFocus
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="할일 제목"
            value={todoForm.title}
            onChange={e => setTodoForm(f => ({ ...f, title: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') saveTodo(); }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              시작일
              <input type="date" value={todoForm.date} onChange={e => setTodoForm(f => ({ ...f, date: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              마감기한
              <input type="date" value={todoForm.due} onChange={e => setTodoForm(f => ({ ...f, due: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              반복
              <select value={todoForm.repeat} onChange={e => setTodoForm(f => ({ ...f, repeat: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {todoForm.repeat !== 'none' && (
              <label className="flex items-center gap-1 text-xs text-gray-600">
                간격
                <input type="number" min="1" max="365" value={todoForm.interval}
                  onChange={e => setTodoForm(f => ({ ...f, interval: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="w-14 border border-gray-300 rounded px-1.5 py-1 text-sm text-center" />
                {todoForm.repeat === 'daily' ? '일' : todoForm.repeat === 'weekly' ? '주' : todoForm.repeat === 'monthly' ? '개월' : '년'}마다
              </label>
            )}
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={todoForm.alarmEnabled} onChange={e => setTodoForm(f => ({ ...f, alarmEnabled: e.target.checked }))} />
              ⏰ 알람
              <input type="time" value={todoForm.time} onChange={e => setTodoForm(f => ({ ...f, time: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </label>
          </div>
          <input
            className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="메모 (선택)"
            value={todoForm.note}
            onChange={e => setTodoForm(f => ({ ...f, note: e.target.value }))}
          />
          <div className="flex gap-2 justify-end">
            <button onClick={saveTodo} disabled={!todoForm.title.trim()}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
              {editingTodo ? '수정' : '추가'}
            </button>
            <button onClick={() => { setShowTodoForm(false); setEditingTodo(null); setTodoForm(blankForm); }}
              className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">취소</button>
          </div>
        </div>
      )}

      {/* 할일 목록 — 일간/주간/월간 (더블클릭으로 완료) */}
      {(() => {
        const dates = rangeDates(todoView);         // 이 뷰에 표시할 날짜 목록
        const rangeSet = dates.map(d => fmtDate(d));
        // 날짜별 발생 할일 그룹
        const groups = dates.map(d => {
          const ds = fmtDate(d);
          const items = todos.filter(t => todoOccursOn(t, ds))
            .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
          return { ds, d, items };
        }).filter(g => g.items.length > 0);
        const totalCnt = groups.reduce((s, g) => s + g.items.length, 0);
        const doneCnt = groups.reduce((s, g) => s + g.items.filter(t => (t.completedDates || []).includes(g.ds)).length, 0);
        const viewLabel = { day: '오늘', week: '이번 주', month: '이번 달' }[todoView];
        return (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-base">📝</span>
              <span className="font-semibold text-gray-800 text-sm">할일 · {viewLabel}</span>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2 text-xs">
                {[['day', '일간'], ['week', '주간'], ['month', '월간']].map(([v, label]) => (
                  <button key={v} onClick={() => setTodoView(v)}
                    className={`px-2.5 py-1 ${todoView === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>{label}</button>
                ))}
              </div>
              {totalCnt > 0 && <span className={`ml-auto text-sm font-bold ${doneCnt === totalCnt ? 'text-green-600' : 'text-blue-600'}`}>{doneCnt}/{totalCnt}</span>}
            </div>
            {groups.length === 0 ? (
              <div className="px-5 py-4 text-sm text-gray-400">{viewLabel} 예정된 할일이 없습니다. "+ 할일 추가"로 등록하세요.</div>
            ) : groups.map(g => (
              <div key={g.ds}>
                {todoView !== 'day' && (
                  <div className="px-5 py-1.5 bg-gray-50/70 text-xs font-semibold text-gray-500 border-b border-gray-100">
                    {g.d.getMonth() + 1}/{g.d.getDate()} ({DOW[g.d.getDay()]}) {g.ds === todayStr() && <span className="text-blue-500">· 오늘</span>}
                  </div>
                )}
                {g.items.map(t => {
                  const done = (t.completedDates || []).includes(g.ds);
                  const dd = t.due ? dueDday(t.due) : null;
                  return (
                    <div key={`${t.id}_${g.ds}`}
                      onDoubleClick={() => handleToggleTodo(t.id, g.ds)}
                      className={`flex items-center px-5 py-2.5 gap-3 cursor-pointer select-none border-b border-gray-50 ${done ? 'bg-green-50/40' : 'hover:bg-blue-50/40'}`}
                      title="더블클릭으로 완료/취소">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs ${done ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                        {done ? '✓' : '○'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{t.title}</p>
                        {t.note && <p className="text-xs text-gray-400 truncate">{t.note}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {t.due && !done && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${dd < 0 ? 'bg-red-100 text-red-600' : dd === 0 ? 'bg-red-100 text-red-600' : dd <= 3 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'}`}>
                            {dd < 0 ? `기한초과 ${-dd}일` : dd === 0 ? '오늘마감' : `D-${dd}`}
                          </span>
                        )}
                        {t.repeat && t.repeat !== 'none' && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">
                            {(t.interval > 1 ? t.interval : '') + REPEAT_LABEL[t.repeat]}
                          </span>
                        )}
                        {t.alarmEnabled && t.time && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded">⏰ {t.time}</span>
                        )}
                        <button onClick={e => { e.stopPropagation(); startEditTodo(t); }} className="text-gray-300 hover:text-blue-500 text-xs px-1">✎</button>
                        <button onClick={e => { e.stopPropagation(); handleDeleteTodo(t.id); }} className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}

      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-xl p-4 border ${overdueCalib.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
          <p className="text-xs text-gray-500">교정 만료</p>
          <p className={`text-3xl font-bold mt-1 ${overdueCalib.length > 0 ? 'text-red-600' : 'text-gray-300'}`}>{overdueCalib.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">건</p>
        </div>
        <div className={`rounded-xl p-4 border ${soonCalib.length > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-200'}`}>
          <p className="text-xs text-gray-500">교정 임박 (60일내)</p>
          <p className={`text-3xl font-bold mt-1 ${soonCalib.length > 0 ? 'text-orange-500' : 'text-gray-300'}`}>{soonCalib.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">건</p>
        </div>
        <div className="rounded-xl p-4 border bg-white border-gray-200">
          <p className="text-xs text-gray-500">이번달 모니터링</p>
          <p className={`text-3xl font-bold mt-1 ${monRate === 100 ? 'text-green-600' : monRate >= 50 ? 'text-blue-600' : 'text-gray-700'}`}>{monRate}%</p>
          <p className="text-xs text-gray-400 mt-0.5">{completedZones.length}/{zones.length} 구역</p>
        </div>
      </div>

      {/* 교정 만료 */}
      {overdueCalib.length > 0 && (
        <Section title="교정 만료 — 즉시 조치 필요" icon="🔴" count={`${overdueCalib.length}건`} countColor="text-red-600">
          {overdueCalib.map(c => (
            <div key={c.id} className="flex items-center px-5 py-3 gap-3 bg-red-50/50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                <p className="text-xs text-gray-400">S/N: {c.sn || '-'} · 교정번호: {c.cert_no || '-'}</p>
              </div>
              <div className="text-right shrink-0">
                <DayBadge days={dDay(c.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.next_calib_date}</p>
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* 교정 임박 */}
      {soonCalib.length > 0 && (
        <Section title="교정 예정 (60일 이내)" icon="⚠️" count={`${soonCalib.length}건`} countColor="text-orange-500">
          {soonCalib.map(c => (
            <div key={c.id} className="flex items-center px-5 py-3 gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                <p className="text-xs text-gray-400">S/N: {c.sn || '-'}</p>
              </div>
              <div className="text-right shrink-0">
                <DayBadge days={dDay(c.next_calib_date)} />
                <p className="text-xs text-gray-400 mt-0.5">{c.next_calib_date}</p>
              </div>
            </div>
          ))}
        </Section>
      )}

      {overdueCalib.length === 0 && soonCalib.length === 0 && (
        <Section title="교정 일정" icon="✅">
          <div className="px-5 py-4 text-sm text-gray-400">60일 이내 교정 예정 항목 없음</div>
        </Section>
      )}

      {/* 이번달 모니터링 */}
      <Section
        title={`${MONTH_KR[month - 1]} 모니터링 현황`}
        icon="📋"
        count={`${completedZones.length}/${zones.length}`}
        countColor={monRate === 100 ? 'text-green-600' : 'text-blue-600'}
      >
        {/* 진행률 바 */}
        <div className="px-5 py-3 border-b border-gray-50">
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
              <div
                className={`h-3 rounded-full transition-all ${monRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${monRate}%` }}
              />
            </div>
            <span className="text-sm font-bold text-gray-700 w-10 text-right">{monRate}%</span>
          </div>
        </div>

        {/* 미완료 구역 */}
        {pendingZones.length > 0 ? (
          <div className="px-5 py-3">
            <p className="text-xs font-medium text-gray-500 mb-2">미완료 구역 ({pendingZones.length}개)</p>
            <div className="flex flex-wrap gap-1.5">
              {pendingZones.map(z => (
                <span key={z.id} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                  {z.name}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-green-600 font-medium">✅ 이번달 모든 구역 모니터링 완료</div>
        )}
      </Section>

      {/* AHU 계획 */}
      {ahuTasks.length > 0 && (
        <Section
          title={`${MONTH_KR[month - 1]} AHU 유지보수`}
          icon="🔧"
          count={`${ahuDone}/${ahuTasks.length} 완료`}
          countColor={ahuDone === ahuTasks.length ? 'text-green-600' : 'text-gray-600'}
        >
          {ahuTasks.map((t, i) => (
            <div key={i} className="flex items-center px-5 py-3 gap-3">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs ${t.done ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                {t.done ? '✓' : '○'}
              </div>
              <p className={`text-sm flex-1 ${t.done ? 'text-gray-400 line-through' : 'text-gray-800 font-medium'}`}>
                {t.ahuName}
              </p>
              {t.note && <p className="text-xs text-gray-400 truncate max-w-[200px]">{t.note}</p>}
              <span className={`text-xs px-2 py-0.5 rounded-full ${t.done ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-700'}`}>
                {t.done ? '완료' : '예정'}
              </span>
            </div>
          ))}
        </Section>
      )}

      {ahuTasks.length === 0 && (
        <Section title={`${MONTH_KR[month - 1]} AHU 유지보수`} icon="🔧">
          <div className="px-5 py-4 text-sm text-gray-400">이번달 예정된 AHU 유지보수 없음</div>
        </Section>
      )}
    </div>
  );
}
