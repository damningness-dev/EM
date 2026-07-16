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
  { value: 'quarter', label: '분기' },
  { value: 'half', label: '반기' },
  { value: 'yearly', label: '매년' },
];
const REPEAT_LABEL = { none: '', daily: '매일', weekly: '매주', monthly: '매월', quarter: '분기', half: '반기', yearly: '매년' };
const NTH_LABEL = ['', '첫째', '둘째', '셋째', '넷째', '마지막'];

function nthWeekdayOfMonth(year, month0, nth, dow) {
  const firstDow = new Date(year, month0, 1).getDay();
  let day = 1 + ((dow - firstDow + 7) % 7);
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  if (nth === 5) { while (day + 7 <= daysInMonth) day += 7; }
  else { day += (nth - 1) * 7; if (day > daysInMonth) return null; }
  return day;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return fmtDate(new Date()); }
// 마감기한 D-day (날짜만 비교)
function dueDday(dueStr) {
  const due = new Date(dueStr + 'T00:00:00');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((due - t) / 86400000);
}
// 뷰(일간/주간/월간)에 표시할 날짜 배열 (anchor 날짜를 기준으로 계산)
function rangeDates(view, anchor) {
  const t = new Date(anchor || new Date()); t.setHours(0, 0, 0, 0);
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

// todo가 특정 날짜에 발생하는지 (일정 반복 반영) — main.js와 동일 로직.
// 반복 없음 + 마감기한이면 마감까지 매일 표시.
function todoOccursOn(todo, dateStr) {
  if (!todo.date || dateStr < todo.date) return false;
  const repeat = todo.repeat || 'none';
  if (repeat === 'none') {
    if (todo.due) return dateStr <= todo.due;
    return dateStr === todo.date;
  }
  if (todo.due && dateStr > todo.due) return false;
  const base = new Date(todo.date + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const interval = Math.max(1, todo.interval || 1);
  const dayDiff = Math.round((d - base) / 86400000);
  if (repeat === 'daily') return dayDiff >= 0 && dayDiff % interval === 0;
  if (repeat === 'weekly') return dayDiff >= 0 && dayDiff % (7 * interval) === 0;
  const per = repeat === 'monthly' ? 1 : repeat === 'quarter' ? 3 : repeat === 'half' ? 6 : repeat === 'yearly' ? 12 : 0;
  if (per > 0) {
    const step = per * interval;
    const months = (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
    if (months < 0 || months % step !== 0) return false;
    if (repeat === 'monthly' && todo.monthlyMode === 'nthWeekday') {
      const day = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), todo.nth || 1, todo.dow || 0);
      return day != null && d.getDate() === day;
    }
    const dom = (repeat === 'monthly' && todo.monthlyMode === 'day' && todo.monthlyDay) ? todo.monthlyDay : base.getDate();
    return d.getDate() === dom;
  }
  return false;
}

function repeatText(todo) {
  const r = todo.repeat || 'none';
  if (r === 'none') return todo.due ? '마감까지 매일' : '';
  const iv = todo.interval > 1 ? todo.interval : '';
  if (r === 'monthly' && todo.monthlyMode === 'nthWeekday') return `${iv}매월 ${NTH_LABEL[todo.nth || 1]} ${DOW[todo.dow || 0]}요일`;
  if (r === 'monthly' && todo.monthlyMode === 'day') return `${iv}매월 ${todo.monthlyDay || ''}일`;
  return iv + REPEAT_LABEL[r];
}
function alarmText(todo) {
  const a = todo.alarm || (todo.alarmEnabled && todo.time ? { enabled: true, mode: 'atTime', time: todo.time, base: 'each' } : null);
  if (!a || !a.enabled) return null;
  const baseKr = a.base === 'start' ? '시작일' : a.base === 'end' ? '종료일' : '일정마다';
  if (a.mode === 'minBefore') return `${baseKr} ${a.minBefore}분 전`;
  if (a.mode === 'dayBefore') return `${baseKr} ${a.dayBefore}일 전 ${a.time}`;
  return `${baseKr} ${a.time}`;
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
  const blankForm = {
    title: '', date: todayStr(), due: '', note: '',
    // 일정 반복
    repeat: 'none', interval: 1, monthlyMode: 'day', monthlyDay: new Date().getDate(), nth: 1, dow: new Date().getDay(),
    // 알람
    alarmEnabled: false, alarmMode: 'atTime', alarmTime: '09:00', alarmMinBefore: 30, alarmDayBefore: 1, alarmBase: 'each',
  };
  const [todoForm, setTodoForm] = useState(blankForm);
  const [todoView, setTodoView] = useState('day'); // day | week | month
  const [todoAnchor, setTodoAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  function shiftTodoAnchor(dir) {
    setTodoAnchor(prev => {
      const d = new Date(prev);
      if (todoView === 'week') d.setDate(d.getDate() + dir * 7);
      else if (todoView === 'month') d.setMonth(d.getMonth() + dir);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  }
  function goTodoToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    setTodoAnchor(d);
  }
  const todoDates = rangeDates(todoView, todoAnchor); // 이 뷰에 표시할 날짜 목록
  const todoRangeSet = todoDates.map(d => fmtDate(d));
  const isTodayPeriod = todoRangeSet.includes(todayStr());
  let todoPeriodLabel;
  if (todoView === 'week') {
    const s = todoDates[0], e = todoDates[todoDates.length - 1];
    todoPeriodLabel = `${s.getMonth() + 1}/${s.getDate()} ~ ${e.getMonth() + 1}/${e.getDate()}`;
  } else if (todoView === 'month') {
    todoPeriodLabel = `${todoDates[0].getFullYear()}년 ${todoDates[0].getMonth() + 1}월`;
  } else {
    const d = todoDates[0];
    todoPeriodLabel = `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})`;
  }

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
    const f = todoForm;
    const alarm = f.alarmEnabled && f.alarmTime ? {
      enabled: true, mode: f.alarmMode || 'atTime', time: f.alarmTime,
      minBefore: Math.max(0, parseInt(f.alarmMinBefore) || 0),
      dayBefore: Math.max(0, parseInt(f.alarmDayBefore) || 0),
      base: f.alarmBase || 'each',
    } : { enabled: false };
    const payload = {
      ...(editingTodo ? { ...todos.find(t => t.id === editingTodo) } : {}),
      title,
      date: f.date || todayStr(),
      due: f.due || '',
      repeat: f.repeat || 'none',
      interval: Math.max(1, parseInt(f.interval) || 1),
      monthlyMode: f.monthlyMode || 'day',
      monthlyDay: Math.max(1, Math.min(31, parseInt(f.monthlyDay) || 1)),
      nth: f.nth || 1, dow: f.dow ?? 0,
      alarm,
      alarmEnabled: alarm.enabled, time: alarm.enabled ? alarm.time : '', // 구형 호환
      note: f.note || '',
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
    const a = t.alarm || (t.alarmEnabled && t.time ? { enabled: true, mode: 'atTime', time: t.time, base: 'each' } : null);
    setTodoForm({
      title: t.title, date: t.date || todayStr(), due: t.due || '', note: t.note || '',
      repeat: t.repeat || 'none', interval: t.interval || 1,
      monthlyMode: t.monthlyMode || 'day', monthlyDay: t.monthlyDay || new Date(t.date + 'T00:00:00').getDate() || 1,
      nth: t.nth || 1, dow: t.dow ?? (t.date ? new Date(t.date + 'T00:00:00').getDay() : 0),
      alarmEnabled: !!(a && a.enabled), alarmMode: a?.mode || 'atTime', alarmTime: a?.time || '09:00',
      alarmMinBefore: a?.minBefore ?? 30, alarmDayBefore: a?.dayBefore ?? 1, alarmBase: a?.base || 'each',
    });
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
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">오늘의 할일</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {year}년 {MONTH_KR[month - 1]} {today.getDate()}일 ({dow}요일)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-sm">
            <span className="font-semibold text-gray-700">{todoPeriodLabel}</span>
            {isTodayPeriod && <span className="text-blue-500 text-xs">· 지금</span>}
            <button onClick={() => shiftTodoAnchor(-1)} title="이전"
              className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-gray-100 rounded text-xs">◀</button>
            {!isTodayPeriod && (
              <button onClick={goTodoToday} className="px-1.5 py-0.5 text-[11px] text-blue-600 hover:underline">오늘</button>
            )}
            <button onClick={() => shiftTodoAnchor(1)} title="다음"
              className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-gray-100 rounded text-xs">▶</button>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
            {[['day', '일간'], ['week', '주간'], ['month', '월간']].map(([v, label]) => (
              <button key={v} onClick={() => setTodoView(v)}
                className={`px-2.5 py-1 ${todoView === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          <button
            onClick={() => { setEditingTodo(null); setTodoForm(blankForm); setShowTodoForm(v => !v); }}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >+ 할일 추가</button>
        </div>
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
          </div>

          {/* 일정 반복 */}
          <div className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold text-gray-500">🔁 일정 반복</span>
            <select value={todoForm.repeat} onChange={e => setTodoForm(f => ({ ...f, repeat: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
              {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {todoForm.repeat === 'none' && todoForm.due && <span className="text-[11px] text-gray-400">마감기한까지 매일 표시</span>}
            {todoForm.repeat !== 'none' && (
              <label className="flex items-center gap-1 text-xs text-gray-600">간격
                <input type="number" min="1" max="365" value={todoForm.interval}
                  onChange={e => setTodoForm(f => ({ ...f, interval: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />
                {todoForm.repeat === 'daily' ? '일' : todoForm.repeat === 'weekly' ? '주' : todoForm.repeat === 'monthly' ? '개월' : todoForm.repeat === 'quarter' ? '분기' : todoForm.repeat === 'half' ? '반기' : '년'}마다
              </label>
            )}
            {todoForm.repeat === 'monthly' && (
              <>
                <select value={todoForm.monthlyMode} onChange={e => setTodoForm(f => ({ ...f, monthlyMode: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                  <option value="day">며칠</option>
                  <option value="nthWeekday">몇째 주 요일</option>
                </select>
                {todoForm.monthlyMode === 'day' ? (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="1" max="31" value={todoForm.monthlyDay}
                      onChange={e => setTodoForm(f => ({ ...f, monthlyDay: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) }))}
                      className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />일
                  </label>
                ) : (
                  <>
                    <select value={todoForm.nth} onChange={e => setTodoForm(f => ({ ...f, nth: parseInt(e.target.value) }))}
                      className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                      {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{NTH_LABEL[n]}</option>)}
                    </select>
                    <select value={todoForm.dow} onChange={e => setTodoForm(f => ({ ...f, dow: parseInt(e.target.value) }))}
                      className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                      {DOW.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
                    </select>
                  </>
                )}
              </>
            )}
          </div>

          {/* 알람 (일정 반복과 별도) */}
          <div className="flex flex-wrap items-center gap-2 bg-orange-50 rounded-lg px-3 py-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
              <input type="checkbox" checked={todoForm.alarmEnabled} onChange={e => setTodoForm(f => ({ ...f, alarmEnabled: e.target.checked }))} />
              ⏰ 알람
            </label>
            {todoForm.alarmEnabled && (
              <>
                <select value={todoForm.alarmBase} onChange={e => setTodoForm(f => ({ ...f, alarmBase: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white" title="알람 기준">
                  <option value="each">일정마다</option>
                  <option value="start">시작일 기준</option>
                  <option value="end">종료일 기준</option>
                </select>
                <select value={todoForm.alarmMode} onChange={e => setTodoForm(f => ({ ...f, alarmMode: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white">
                  <option value="atTime">일정 시각에</option>
                  <option value="minBefore">몇 분 전</option>
                  <option value="dayBefore">며칠 전</option>
                </select>
                {todoForm.alarmMode === 'minBefore' && (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="0" max="1440" value={todoForm.alarmMinBefore}
                      onChange={e => setTodoForm(f => ({ ...f, alarmMinBefore: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-14 border border-gray-300 rounded px-1 py-1 text-sm text-center" />분 전
                  </label>
                )}
                {todoForm.alarmMode === 'dayBefore' && (
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="number" min="0" max="60" value={todoForm.alarmDayBefore}
                      onChange={e => setTodoForm(f => ({ ...f, alarmDayBefore: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-12 border border-gray-300 rounded px-1 py-1 text-sm text-center" />일 전
                  </label>
                )}
                <label className="flex items-center gap-1 text-xs text-gray-600">시각
                  <input type="time" value={todoForm.alarmTime} onChange={e => setTodoForm(f => ({ ...f, alarmTime: e.target.value }))}
                    className="border border-gray-300 rounded px-2 py-1 text-sm" />
                </label>
              </>
            )}
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
        // 날짜별 발생 할일 그룹
        const groups = todoDates.map(d => {
          const ds = fmtDate(d);
          const items = todos.filter(t => todoOccursOn(t, ds))
            .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
          return { ds, d, items };
        }).filter(g => g.items.length > 0);
        const totalCnt = groups.reduce((s, g) => s + g.items.length, 0);
        const doneCnt = groups.reduce((s, g) => s + g.items.filter(t => (t.completedDates || []).includes(g.ds)).length, 0);
        return (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-base">📝</span>
              <span className="font-semibold text-gray-800 text-sm">할일 · {todoPeriodLabel}</span>
              {totalCnt > 0 && <span className={`ml-auto text-sm font-bold ${doneCnt === totalCnt ? 'text-green-600' : 'text-blue-600'}`}>{doneCnt}/{totalCnt}</span>}
            </div>
            {groups.length === 0 ? (
              <div className="px-5 py-4 text-sm text-gray-400">{todoPeriodLabel} 예정된 할일이 없습니다. "+ 할일 추가"로 등록하세요.</div>
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
                        {repeatText(t) && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">🔁 {repeatText(t)}</span>
                        )}
                        {alarmText(t) && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded">⏰ {alarmText(t)}</span>
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
