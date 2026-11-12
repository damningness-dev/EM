import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchWeeklyDuty, fetchWeeklyBoard, saveWeeklyBoard, syncAfterChange, fetchZones, fetchHolidays, fetchBlockedDates, fetchScheduleConfig, fetchTempSchedules } from '../lib/api';
import { buildHolidayMap, setScheduleConfig, totalCount } from '../lib/schedule';
import { mergeScheduleConfig, buildZoneOrderRank, buildScheduleByDate, monitoringButtons } from '../lib/monitoringDay';
import { boardTasksOn, scheduleLabel, ROTATION_UNITS, rotationState, rotationPool, rotationLabel, fmtDate } from '../lib/boardRotation';

// TEST 메뉴 — 업무 배치판. 기존 "주간근무" 메뉴는 그대로 두고, 같은 직원 목록을 가로 칸으로 펼친 뒤
// 업무 버튼을 끌어다(드래그 앤 드롭) 근무자에게 배치한다. 배치된 업무마다 기한과 진행상태를 입력하고,
// 근무자마다 색이 달라 누구 업무인지 한눈에 보인다. 나중에 주간근무와 합치거나 바꿀 수 있도록
// 배치 내용은 따로(weeklyBoard) 저장한다. 수정은 관리자만 할 수 있고, 나머지 계정은 보기만 한다.
// 업무마다 로테이션(🔄)을 켤 수 있다 — 정한 주기마다 담당이 다른 인원에게 순차 또는 무작위로 자동으로 넘어간다
// (계산 규칙은 lib/boardRotation.js). 로테이션 업무는 배치 목록이 아니라 주기에 따라 자리가 정해진다.
//   board = { tasks: [{ id, name, kind, rotation? }], assignments: { '<직원>': [taskId] },
//             progress: { '<직원>': { '<taskId>': { due, status, period? } } } }

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
const KIND_SHORT = { daily: '일일', weekly: '주간', monthly: '월간', '': '기타' };
const KIND_BADGE = { daily: 'bg-sky-100 text-sky-700 border-sky-300', weekly: 'bg-violet-100 text-violet-700 border-violet-300', monthly: 'bg-rose-100 text-rose-700 border-rose-300', '': 'bg-gray-100 text-gray-500 border-gray-300' };
const DOW_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const DOW = DOW_NAMES;
// 일별 보기: 달력 표시 설정과 무관하게, 마감기한 없는 기타 업무는 매일, 마감기한이 있는 기타 업무는 마감일까지 계속(미완료면 지난 뒤에도 오늘까지)
const dayOpts = () => ({ ignoreFlag: true, includeUndated: true, untilDue: true, today: todayStr() });
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
    .map(t => ({ id: `wd_${t.id}`, name: String(t.name).trim(), kind, showOnCalendar: false, ...(t.alarmTime ? { alarmTime: t.alarmTime } : {}) }));
  return [...pick(duty.dailyTasks, 'daily'), ...pick(duty.weeklyTasks, 'weekly'), ...pick(duty.monthlyTasks, 'monthly')];
}

// 마감까지 남은 날: D-3 / D-DAY / D+2(지남). 7일 이내 노랑, 마감일·지남 빨강, 완료는 회색.
function dueLabel(due, status) {
  if (!due) return null;
  const diff = Math.round((new Date(due + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
  const text = diff === 0 ? 'D-DAY' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  if (status === 'done') return { text, cls: 'text-gray-400 bg-gray-50 border-gray-200' };
  if (diff <= 0) return { text, cls: 'text-red-600 bg-red-50 border-red-200' };
  if (diff <= 7) return { text, cls: 'text-yellow-700 bg-yellow-100 border-yellow-300' }; // 일주일 전부터 노랑
  return { text, cls: 'text-gray-500 bg-white/70 border-gray-300' };
}

export default function TestBoard({ adminUnlocked }) {
  const [staff, setStaff] = useState(null);
  const [duty, setDuty] = useState(null);
  const [board, setBoard] = useState({ tasks: [], assignments: {}, progress: {}, monAssign: {} });
  const [overCol, setOverCol] = useState(null);
  const [overPalette, setOverPalette] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tip, setTip] = useState(null); // { id, who, x, y, up } — 업무 칩 위에 마우스를 올렸을 때의 안내
  const [kindMenu, setKindMenu] = useState(null); // { id, x, y } — 업무 버튼 구분 선택 메뉴
  const [taskDlg, setTaskDlg] = useState(null); // { id|null(새 업무), draft } — 업무 상세 창
  // [환경모니터링] 구역: 월별 모니터링 일정(구역별 측정 일정)을 읽어 와서 고른 날짜의 일정을 버튼으로 보여준다.
  const [mon, setMon] = useState({ zones: [], holidayDefs: [], blocked: [], temps: [] });
  const [monDate, setMonDate] = useState(todayStr()); // 화면 전체의 기준 날짜
  const [viewMode, setViewMode] = useState('day'); // 'day' 일별 보기 / 'all' 전체 보기
  const monYear = parseInt(monDate.slice(0, 4));
  const monHolidays = useMemo(() => buildHolidayMap(mon.holidayDefs, monYear - 1, monYear + 1), [mon.holidayDefs, monYear]);
  const monByDate = useMemo(() => {
    const avoid = { ...monHolidays };
    mon.blocked.forEach(d => { if (!avoid[d]) avoid[d] = '일정비우기'; });
    return buildScheduleByDate(mon.zones, avoid, buildZoneOrderRank(mon.zones));
  }, [mon, monHolidays]);
  const monTempByDate = useMemo(() => {
    const m = {};
    mon.temps.forEach(t => { if (t?.date) (m[t.date] = m[t.date] || []).push(t); });
    return m;
  }, [mon.temps]);
  const saveTimer = useRef(null);
  const seeded = useRef(false);

  const adminRef = useRef(adminUnlocked);
  useEffect(() => { adminRef.current = adminUnlocked; }, [adminUnlocked]);
  function loadMonitoring() {
    Promise.all([fetchZones(), fetchHolidays(), fetchBlockedDates(), fetchScheduleConfig(), fetchTempSchedules()]).then(([zones, holidayDefs, blocked, cfg, temps]) => {
      setScheduleConfig(mergeScheduleConfig(cfg)); // 일정 계산 함수가 읽는 주기 설정
      setMon({
        zones: (zones || []).map(z => z.category === '청정등급' ? { ...z, category: '공조' } : z),
        holidayDefs: holidayDefs || [], blocked: [...(blocked || [])], temps: temps || [],
      });
    }).catch(() => {});
  }
  function load() {
    loadMonitoring();
    Promise.all([fetchWeeklyDuty().catch(() => null), fetchWeeklyBoard().catch(() => null)]).then(([d, b]) => {
      setDuty(d || null);
      setStaff(Array.isArray(d?.staff) ? d.staff : []);
      const loadedBoard = { tasks: b?.tasks || [], assignments: b?.assignments || {}, progress: b?.progress || {}, monAssign: b?.monAssign || {} };
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

  // 업무 상세 창 — 새 업무(id 없음) 또는 기존 업무를 열어 이름·구분·알림시간·메모·로테이션을 입력/수정한다.
  const defaultRot = () => ({ on: false, unit: 'week', every: 1, mode: 'sequential', start: fmtDate(new Date()), first: '', pool: [], seed: 1, overrides: {} });
  function openTask(task) {
    setTip(null);
    if (!task && !guard()) return;
    const r = task?.rotation;
    setTaskDlg({
      id: task?.id || null,
      draft: {
        name: task?.name || '', kind: task?.kind || '', alarmTime: task?.alarmTime || '', note: task?.note || '',
        showCal: task ? task.showOnCalendar !== false : false, // 새 업무는 월별 일정 표시를 끈 상태가 기본
        curWorker: '',
        assign: task ? staff.filter(w => (board.assignments[w] || []).includes(task.id)) : [],
        due: task?.due || '', dow: task?.dow, monthDay: task?.monthDay, weekdaysOnly: task?.weekdaysOnly,
        rot: r ? { ...r, pool: [...(r.pool || [])], overrides: { ...(r.overrides || {}) } } : defaultRot(),
      },
    });
  }
  function saveTask() {
    const { id, draft } = taskDlg;
    const name = draft.name.trim();
    if (!name || !guard()) return;
    const cur = id ? board.tasks.find(t => t.id === id) : null;
    const taskId = id || newTaskId();
    const fields = {
      name, kind: draft.kind, alarmTime: draft.kind && draft.alarmTime ? draft.alarmTime : undefined, due: !draft.kind && draft.due ? draft.due : undefined, note: draft.note.trim() ? draft.note : undefined,
      // 구분에 맞는 주기 값만 남긴다(기본값이면 저장하지 않는다)
      showOnCalendar: draft.showCal === false ? false : undefined, // 기본은 표시
      dow: draft.kind === 'weekly' && draft.dow != null && draft.dow !== 1 ? draft.dow : undefined,
      monthDay: draft.kind === 'monthly' && draft.monthDay != null && draft.monthDay !== 'edge' ? draft.monthDay : undefined,
      weekdaysOnly: draft.kind === 'daily' && draft.weekdaysOnly === false ? false : undefined,
    };
    setTaskDlg(null);
    let tasks = cur ? board.tasks.map(t => t.id === id ? { ...t, ...fields } : t) : [...board.tasks, { id: taskId, ...fields }];
    const assignments = { ...board.assignments };
    let progress = board.progress;
    const rd = draft.rot;
    const wasOn = !!cur?.rotation?.on;
    let msg = '';
    // 배치 체크박스 반영(로테이션을 쓰지 않을 때): 체크 해제된 사람은 배치와 진행 기록을 함께 정리한다.
    const applyChecked = (list) => {
      progress = { ...board.progress };
      staff.forEach(w => {
        const has = (assignments[w] || []).includes(taskId), want = list.includes(w);
        if (want && !has) assignments[w] = [...(assignments[w] || []), taskId];
        if (!want && has) {
          assignments[w] = assignments[w].filter(x => x !== taskId);
          if (progress[w]?.[taskId]) { const { [taskId]: _d, ...rest } = progress[w]; progress[w] = rest; } // eslint-disable-line no-unused-vars
        }
      });
    };
    if (!rd.on) {
      if (wasOn && draft.assign.length === 0) {
        // 로테이션을 끄고 따로 고른 사람이 없으면 지금 담당자에게 일반 배치로 남긴다.
        const now = rotationState(cur, staff)?.worker;
        if (now) applyChecked([now]);
        msg = '로테이션을 껐습니다. 지금 담당자에게 일반 배치로 남았습니다.';
      } else {
        applyChecked(draft.assign);
        if (wasOn) msg = '로테이션을 껐습니다.';
      }
      if (wasOn) tasks = tasks.map(t => { if (t.id !== taskId) return t; const { rotation: _r, ...rest } = t; return rest; }); // eslint-disable-line no-unused-vars
    } else {
      // 새로 켤 때: 체크한(배치된) 첫 사람을 1주기 담당으로 삼고, 일반 배치는 로테이션이 대신한다.
      const placed = staff.filter(w => draft.assign.includes(w));
      const pool = rotationPool({ rotation: rd }, staff);
      const first = wasOn ? (rd.first || cur.rotation.first) : (placed.find(w => pool.includes(w)) || pool[0] || '');
      const rotation = { ...rd, on: true, first, every: Math.max(1, parseInt(rd.every) || 1), seed: wasOn ? (rd.seed || 1) : (1 + Math.floor(Math.random() * 2147483000)) };
      if (wasOn) {
        // 이미 돌고 있는 로테이션을 고친 경우: 주기·순서·대상 인원이 바뀌어도 "지금 담당자"는 그대로 두고(또는 상세창에서
        // 고른 사람으로 바꾸고) 다음 순서가 그 사람부터 새 설정대로 이어지게 한다.
        const oldRs = rotationState(cur, staff);
        const keep = draft.curWorker || oldRs?.worker;
        const changed = ['unit', 'every', 'start', 'mode'].some(k => String(rd[k]) !== String(cur.rotation[k])) || JSON.stringify(rd.pool || []) !== JSON.stringify(cur.rotation.pool || []);
        if ((changed || (draft.curWorker && draft.curWorker !== oldRs?.worker)) && keep && staff.includes(keep)) {
          rotation.overrides = {};
          const ns = rotationState({ ...cur, rotation }, staff);
          if (ns && ns.worker !== keep) rotation.overrides = { [ns.k]: keep };
        }
      }
      tasks = tasks.map(t => t.id === taskId ? { ...t, rotation } : t);
      if (!wasOn) staff.forEach(w => { assignments[w] = (assignments[w] || []).filter(x => x !== taskId); });
      msg = `로테이션 설정을 저장했습니다 (${rotationLabel(rotation)}).`;
    }
    commit({ ...board, tasks, assignments, progress });
    if (msg) flash(msg);
  }
  function showTip(e, t, who) {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ id: t.id, who, x: Math.max(8, Math.min(r.left, window.innerWidth - 308)), y: r.bottom + 8, top: r.top - 8, up: r.bottom + 280 > window.innerHeight });
  }
  // 구분 변경(업무 버튼 앞 배지에서 고른다). 주기·마감기한 값은 지우지 않고 남겨 두어 되돌리면 그대로 쓸 수 있다.
  function setKind(id, kind) {
    setKindMenu(null);
    if (!guard()) return;
    commit({ ...board, tasks: board.tasks.map(x => x.id === id ? { ...x, kind } : x) });
  }
  function removeTask(id) {
    if (!guard()) return;
    if (!confirm('이 업무 버튼을 삭제할까요? 근무자에게 배치된 것과 기한·진행상태도 함께 사라집니다.')) return;
    const assignments = {}, progress = {};
    Object.entries(board.assignments).forEach(([who, ids]) => { assignments[who] = ids.filter(x => x !== id); });
    Object.entries(board.progress).forEach(([who, per]) => { const { [id]: _drop, ...rest } = per || {}; progress[who] = rest; }); // eslint-disable-line no-unused-vars
    commit({ ...board, tasks: board.tasks.filter(t => t.id !== id), assignments, progress });
  }
  // 기한·진행상태 입력. 로테이션 업무는 "이번 주기" 기록으로 남기고(주기가 바뀌면 자동으로 새로 시작), 같은
  // 업무의 다른 사람 기록은 정리한다.
  function setProgress(who, taskId, patch) {
    if (!guard()) return;
    const task = board.tasks.find(t => t.id === taskId);
    const rs = task?.rotation?.on ? rotationState(task, staff, viewD) : null;
    const cur = rs ? prOf(task, who, rs) : ((board.progress[who] || {})[taskId] || { due: '', status: 'todo' });
    const entry = { ...cur, ...patch, ...(rs ? { period: rs.k } : {}) };
    delete entry.auto;
    const progress = { ...board.progress };
    if (rs) Object.keys(progress).forEach(w => { if (w !== who && progress[w]?.[taskId]) { const { [taskId]: _d, ...rest } = progress[w]; progress[w] = rest; } }); // eslint-disable-line no-unused-vars
    progress[who] = { ...(progress[who] || {}), [taskId]: entry };
    commit({ ...board, progress });
  }
  // 한 사람·한 업무의 기한/진행상태. 로테이션 업무는 이번 주기에 입력한 것만 쓰고, 없으면 주기 끝날을
  // 기한으로 한 새 항목(대기)이다.
  function prOf(task, who, rs) {
    const stored = (board.progress[who] || {})[task.id];
    const base = task.rotation?.on && rs
      ? (stored && stored.period === rs.k ? stored : { due: rs.endDate, status: 'todo', auto: true })
      : (stored || { due: '', status: 'todo' });
    // 기타 업무의 마감기한은 업무 상세창에서 정한 값이 우선(없으면 예전에 칸에서 입력한 값/로테이션 주기 끝날)
    return !task.kind && task.due ? { ...base, due: task.due } : base;
  }

  // ── 로테이션 ── (설정은 업무 상세 창 안에서 한다)
  // 로테이션 업무를 다른 근무자 칸에 놓으면 "이번 주기"만 그 사람이 맡도록 바꾼다(다음 주기부터는 원래 순서).
  function overrideThisPeriod(task, who) {
    const rs = rotationState(task, staff, viewD);
    if (!rs || rs.worker === who) return;
    const rotation = { ...task.rotation, overrides: { ...(task.rotation.overrides || {}), [rs.k]: who } };
    commit({ ...board, tasks: board.tasks.map(t => t.id === task.id ? { ...t, rotation } : t) });
    flash(task.rotation.mode === 'random' ? `이번 주기(${rs.startDate.slice(5).replace('-', '/')}~${rs.endDate.slice(5).replace('-', '/')})는 ${who}님이 맡습니다.` : `이번 주기부터 ${who}님이 맡고, 다음 순서는 ${who}님 다음 사람부터 이어집니다.`);
  }

  // ── 드래그 앤 드롭 ──
  // 업무 버튼(palette)을 칸에 놓으면 그 근무자에게 배치(같은 업무를 여러 명에게도 가능),
  // 배치된 칩(placed)을 다른 칸에 놓으면 기한·진행상태와 함께 이동, 업무 영역에 놓으면 배치 해제.
  function startDrag(e, payload) {
    setTip(null);
    if (!adminUnlocked) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
  }
  function readDrag(e) { try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; } }
  function dropOnStaff(e, who) {
    e.preventDefault(); setOverCol(null);
    const d = readDrag(e);
    if ((d?.kind === 'mon' || d?.kind === 'mon-placed') && d.mkey && d.date) {
      if (guard()) setMonAssign(d.date, d.mkey, { who, label: d.label, tip: d.tip });
      return;
    }
    if (!d?.taskId || !guard()) return;
    const dragged = board.tasks.find(t => t.id === d.taskId);
    if (dragged?.rotation?.on) { overrideThisPeriod(dragged, who); return; }
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
    const next = { ...board, assignments, progress };
    commit(next);
    if (viewMode === 'day' && !boardTasksOn(next, staff, monDate, !!monHolidays[monDate], dayOpts()).some(i => i.id === d.taskId && i.workers.includes(who))) {
      flash('배치했습니다. 이 날짜에는 해당하지 않아 일별 보기에서는 보이지 않습니다(전체 보기에서 확인).');
    }
  }
  // 환경모니터링(EM) 일정 버튼 배치: 날짜·항목별로 한 명에게 배정(다른 사람 칸에 놓으면 이동)
  function setMonAssign(date, mkey, value) {
    const monAssign = { ...(board.monAssign || {}) };
    const day = { ...(monAssign[date] || {}) };
    if (value) day[mkey] = value; else delete day[mkey];
    if (Object.keys(day).length) monAssign[date] = day; else delete monAssign[date];
    commit({ ...board, monAssign });
  }
  function dropOnPalette(e) {
    e.preventDefault(); setOverPalette(false);
    const d = readDrag(e);
    if (d?.kind === 'mon-placed') { if (guard()) setMonAssign(d.date, d.mkey, null); return; } // EM 버튼을 영역으로 돌려놓으면 배치 해제
    if (d?.kind !== 'placed' || !d.from) return;
    if (board.tasks.find(t => t.id === d.taskId)?.rotation?.on) { flash('로테이션 업무는 🔄 설정에서 끌 수 있습니다.', true); return; }
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
  // 일별 보기에서는 고른 날짜 기준으로 로테이션 주기·담당을 계산한다
  const viewD = viewMode === 'day' ? new Date(monDate + 'T00:00:00') : undefined;
  const rotOf = (t) => (t?.rotation?.on ? rotationState(t, staff, viewD) : null);
  // 일반 배치 + 로테이션으로 이번 주기에 그 사람이 맡은 업무
  const workersOf = (id) => {
    const t = taskById.get(id); const rs = rotOf(t);
    return rs ? [rs.worker] : staff.filter(w => (board.assignments[w] || []).includes(id));
  };
  const idsOf = (who) => [
    ...(board.assignments[who] || []).filter(id => taskById.has(id) && !taskById.get(id).rotation?.on),
    ...board.tasks.filter(t => rotOf(t)?.worker === who).map(t => t.id),
  ];
  const dayItems = viewMode === 'day' ? boardTasksOn(board, staff, monDate, !!monHolidays[monDate], dayOpts()) : null;
  const shownIds = (who) => (dayItems ? dayItems.filter(i => i.workers.includes(who)).map(i => i.id) : idsOf(who));
  const groups = KIND_ORDER.map(k => ({ kind: k, tasks: board.tasks.filter(t => (t.kind || '') === k) })).filter(g => g.tasks.length > 0);
  // 로테이션 설정 입력 폼(업무 상세 창 안) — d: 로테이션 초안, set: 일부 값 변경
  function rotationForm(task, d, set) {
    // 새로 켜는 경우 저장할 때와 같이: 지금 배치된 사람이 첫 담당(대상 인원에 있을 때)
    const pv = !task?.rotation?.on ? (() => { const pool = rotationPool({ rotation: d }, staff); const placed = staff.find(w => (taskDlg?.draft.assign || []).includes(w) && pool.includes(w)); return placed ? { ...d, first: placed } : d; })() : d;
    const preview = d.on && staff.length > 0 ? rotationState({ ...task, rotation: pv }, staff, new Date(), 5) : null;
    return (
      <>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-3 cursor-pointer select-none">
                <input type="checkbox" checked={!!d.on} onChange={e => set({ on: e.target.checked })} /> 로테이션 사용 (정한 주기마다 담당이 자동으로 넘어갑니다)
              </label>
              {/* 로테이션을 체크했을 때만 세부 설정을 펼친다 */}
              {d.on && (
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/30 px-3 pt-3 pb-1">
                <div className="flex items-center gap-2 mb-3 text-sm">
                  <span className="w-14 text-gray-500 text-xs">주기</span>
                  <input type="number" min="1" max="60" value={d.every} onChange={e => set({ every: e.target.value })} className="w-16 border border-gray-300 rounded px-2 py-1 text-center" />
                  <select value={d.unit} onChange={e => set({ unit: e.target.value })} className="border border-gray-300 rounded px-2 py-1 bg-white">
                    {ROTATION_UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <span className="text-gray-500">마다 담당 변경</span>
                </div>
                <div className="flex items-center gap-3 mb-3 text-sm">
                  <span className="w-14 text-gray-500 text-xs">방식</span>
                  {[['sequential', '순차 (직원 순서대로)'], ['random', '무작위 (직전 담당 제외)']].map(([v, l]) => (
                    <label key={v} className="flex items-center gap-1 cursor-pointer select-none">
                      <input type="radio" checked={d.mode === v} onChange={() => set({ mode: v })} /> {l}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2 mb-3 text-sm">
                  <span className="w-14 text-gray-500 text-xs">시작일</span>
                  <input type="date" value={d.start} onChange={e => set({ start: e.target.value })} className="border border-gray-300 rounded px-2 py-1" />
                  <span className="text-[11px] text-gray-400">이 날부터 1주기</span>
                </div>
                <div className="flex items-start gap-2 mb-3 text-sm">
                  <span className="w-14 text-gray-500 text-xs pt-1">대상 인원</span>
                  <div className="flex-1">
                    {(() => {
                      // 순서 = 대상 인원 목록의 순서(비어 있으면 직원 목록 순서 그대로). 칩을 끌어서 앞뒤를 바꾼다.
                      const order = d.pool.length ? d.pool.filter(w => staff.includes(w)) : staff;
                      const rest = staff.filter(w => !order.includes(w));
                      const put = (arr) => set({ pool: arr.length === staff.length && arr.every((x, i) => x === staff[i]) ? [] : arr });
                      const move = (from, to) => {
                        if (!from || from === to || !order.includes(from) || !order.includes(to)) return;
                        const arr = order.filter(x => x !== from);
                        arr.splice(order.indexOf(to), 0, from);
                        put(arr);
                      };
                      return (
                        <>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {order.map((w, i) => (
                              <div key={w} draggable
                                onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'rot:' + w); }}
                                onDragOver={e => e.preventDefault()}
                                onDrop={e => { e.preventDefault(); e.stopPropagation(); const t = e.dataTransfer.getData('text/plain'); if (t.startsWith('rot:')) move(t.slice(4), w); }}
                                title="끌어서 순서 변경"
                                className="inline-flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border border-gray-300 bg-white text-sm cursor-grab active:cursor-grabbing select-none shadow-sm">
                                <span className="text-[10px] font-bold text-indigo-500 w-3 text-center">{i + 1}</span>
                                <span className={`w-2.5 h-2.5 rounded-full ${colorOf(w).dot}`} />{w}
                                {order.length > 1 && <button type="button" onClick={() => put(order.filter(x => x !== w))} className="text-gray-300 hover:text-red-500 text-xs leading-none px-0.5" title="이 인원 제외">✕</button>}
                              </div>
                            ))}
                            {rest.map(w => (
                              <button key={w} type="button" onClick={() => put([...order, w])}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-gray-300 text-sm text-gray-400 hover:text-gray-700 hover:border-gray-400"
                                title="대상 인원에 추가(맨 뒤)">+ <span className={`w-2.5 h-2.5 rounded-full opacity-50 ${colorOf(w).dot}`} />{w}</button>
                            ))}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-1">{d.mode === 'random' ? '무작위는 순서와 관계없이 이 인원 중에서 뽑습니다.' : '칩을 끌어 다른 칩 자리에 놓으면 순서가 바뀝니다. 1번부터 차례로 돌아갑니다.'}</p>
                        </>
                      );
                    })()}
                  </div>
                </div>
                {preview && (
                  <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-900 mb-3">
                    <p className="font-semibold mb-1">미리보기 (순서)</p>
                    <p>이번 주기 {preview.startDate.slice(5).replace('-', '/')}~{preview.endDate.slice(5).replace('-', '/')} : <b>{preview.worker}</b></p>
                    {preview.upcoming.map(u => <p key={u.k} className="text-indigo-700">{u.startDate.slice(5).replace('-', '/')}~{u.endDate.slice(5).replace('-', '/')} : {u.worker}</p>)}
                    {d.mode === 'random' && <p className="text-[10px] text-indigo-400 mt-1">무작위 순서는 한 번 정해지면 모든 PC에서 똑같이 유지됩니다.</p>}
                  </div>
                )}
              </div>
              )}
      </>
    );
  }
  // 모든 업무의 월별 일정 표시를 한 번에 끄기/켜기
  function setAllCalendar(on) {
    if (!guard()) return;
    if (!confirm(on ? '모든 업무를 월별 모니터링 일정에 표시할까요?' : '모든 업무의 월별 모니터링 일정 표시를 끌까요?\n(업무별로 상세창에서 다시 켤 수 있습니다)')) return;
    commit({ ...board, tasks: board.tasks.map(t => { const { showOnCalendar: _s, ...rest } = t; return on ? rest : { ...rest, showOnCalendar: false }; }) }); // eslint-disable-line no-unused-vars
    flash(on ? '모든 업무를 달력에 표시합니다.' : '모든 업무의 달력 표시를 껐습니다.');
  }
  const calOnCount = board.tasks.filter(t => t.showOnCalendar !== false).length;

  // ── 일별 보기 ──
  // 위쪽 날짜 막대에서 고른 날짜(monDate)가 화면 전체의 기준이다. '일별' 보기에서는 근무자 칸에 그 날 해야 하는 업무만
  // (매일·주간·월간 주기와 마감기한, 로테이션은 그 날짜의 담당 기준) 나오고, '전체' 보기에서는 배치된 업무가 모두 나온다.
  const emItemsOf = (ds) => {
    const BTN = { air: 'bg-emerald-100 text-emerald-800 border-emerald-300', particle: 'bg-violet-100 text-violet-800 border-violet-300', surface: 'bg-amber-100 text-amber-800 border-amber-300', name: 'bg-gray-100 text-gray-700 border-gray-300' };
    return [
      ...(monByDate[ds] || []).flatMap(({ zone, measurement }) => monitoringButtons(zone).map(b => ({ ...b, mkey: `${zone.id}:${b.key}`, cls: BTN[b.key], tip: `${zone.category} · ${zone.grade || ''} ${measurement.num}/${totalCount(zone)}회차` }))),
      ...(monTempByDate[ds] || []).flatMap(t => monitoringButtons(t, { suffix: '[임시]' }).map(b => ({ ...b, mkey: `t${t.id}:${b.key}`, cls: 'bg-orange-50 text-orange-700 border-orange-300', tip: '임시일정' }))),
    ];
  };
  const dayCount = (ds) => boardTasksOn(board, staff, ds, !!monHolidays[ds], dayOpts()).length + emItemsOf(ds).length;

  function dayBar() {
    const weekStartMon = (() => { try { return localStorage.getItem('em-week-start') === 'mon'; } catch { return false; } })();
    const base = new Date(monDate + 'T00:00:00');
    const startOff = weekStartMon ? (base.getDay() + 6) % 7 : base.getDay();
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() - startOff + i); return d; });
    const shift = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); setMonDate(fmtDate(d)); };
    const hol = monHolidays[monDate];
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 mb-4">
        {/* 제목: ○○년 ○월 ○일 일일업무 — 양 끝 화살표로 하루씩 이동 */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <button type="button" onClick={() => shift(-1)} title="전날" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full border border-gray-300 bg-white text-xl leading-none text-gray-600 hover:bg-gray-50">‹</button>
          <h2 className="flex-1 text-center text-xl font-bold text-gray-800">
            {base.getFullYear()}년 {base.getMonth() + 1}월 {base.getDate()}일 일일업무
            <span className={`ml-2 text-sm font-semibold ${base.getDay() === 0 || hol ? 'text-red-500' : base.getDay() === 6 ? 'text-blue-500' : 'text-gray-400'}`}>({DOW[base.getDay()]}요일){hol ? ` · ${hol}` : ''}</span>
          </h2>
          <button type="button" onClick={() => shift(1)} title="다음날" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full border border-gray-300 bg-white text-xl leading-none text-gray-600 hover:bg-gray-50">›</button>
        </div>
        <div className="flex items-center justify-center gap-2 mb-2.5 flex-wrap">
          <div className="inline-flex rounded-lg overflow-hidden border border-gray-300 text-xs font-medium">
            <button type="button" onClick={() => setViewMode('day')} className={`px-3 py-1 ${viewMode === 'day' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`} title="고른 날짜에 해야 하는 업무만 보기">일별 보기</button>
            <button type="button" onClick={() => setViewMode('all')} className={`px-3 py-1 border-l border-gray-300 ${viewMode === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`} title="배치된 업무를 날짜와 관계없이 모두 보기">전체 보기</button>
          </div>
          <span className="text-[11px] text-gray-400">{viewMode === 'day' ? '개인별 업무표에 이 날 해당하는 업무만 나옵니다' : '배치된 업무를 모두 보여줍니다 (날짜는 환경모니터링 일정용)'}</span>
          <button type="button" onClick={() => setMonDate(todayStr())} className="px-2 py-0.5 text-xs rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">오늘</button>
          <input type="date" value={monDate} onChange={e => e.target.value && setMonDate(e.target.value)} className="text-xs rounded border border-gray-300 px-1.5 py-0.5 text-gray-600" />
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map(d => {
            const ds = fmtDate(d); const sel = ds === monDate; const n = dayCount(ds); const isToday = ds === todayStr(); const off = d.getDay() === 0 || !!monHolidays[ds];
            return (
              <button key={ds} type="button" onClick={() => setMonDate(ds)} title={monHolidays[ds] || ''}
                className={`flex flex-col items-center py-1 rounded-lg border text-xs transition-colors ${sel ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 hover:bg-blue-50'}`}>
                <span className={`font-semibold ${sel ? '' : off ? 'text-red-500' : d.getDay() === 6 ? 'text-blue-500' : 'text-gray-600'}`}>{DOW[d.getDay()]}</span>
                <span className={`text-[11px] ${sel ? 'text-white/90' : isToday ? 'text-blue-600 font-bold' : 'text-gray-400'}`}>{d.getMonth() + 1}/{d.getDate()}</span>
                <span className={`mt-0.5 text-[10px] leading-none px-1 py-0.5 rounded-full ${n ? (sel ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700') : 'opacity-0'}`} title="이 날 업무+모니터링 일정 건수">{n || 0}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // [환경모니터링(EM)] 구역 — 고른 날짜의 모니터링 일정이 측정 종류별 버튼으로 나온다. 버튼은 근무자 칸으로 끌어다 배치할 수 있다.
  function monitoringBox() {
    const items = emItemsOf(monDate);
    const assigned = board.monAssign?.[monDate] || {};
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2.5 mb-3">
        <p className="text-xs font-bold text-emerald-700 mb-2">🌿 환경모니터링 <span className="px-1 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold align-middle">EM</span>
          <span className="font-normal text-gray-400"> — {parseInt(monDate.slice(5, 7))}/{parseInt(monDate.slice(8))} 모니터링 일정 {items.length}건{adminUnlocked ? ' · 끌어서 근무자에게 배치' : ''}</span></p>
        {items.length === 0 ? (
          <p className="text-xs text-gray-300 py-1">이 날은 모니터링 일정이 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map(b => {
              const who = assigned[b.mkey]?.who;
              return (
                <span key={b.mkey} title={b.tip + (who ? ` · 배치: ${who}` : '')}
                  draggable={adminUnlocked}
                  onDragStart={e => startDrag(e, { kind: 'mon', date: monDate, mkey: b.mkey, label: b.label, tip: b.tip })}
                  className={`inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border text-sm font-medium shadow-sm select-none ${b.cls} ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                  <span className="text-[10px] leading-none font-bold px-1.5 py-1 rounded border bg-white/70 border-emerald-300 text-emerald-700">EM</span>
                  {b.label}
                  {who && <span className={`w-2.5 h-2.5 rounded-full ${colorOf(who).dot}`} />}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }
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
        기존 "주간근무" 메뉴는 그대로 두었습니다. 직원 목록과 업무는 주간근무에서 가져온 것이고, 업무 버튼을 근무자 칸으로 끌어다 놓아 배치하세요. 마감기한·완료표시는 구분이 '기타'인 업무만 입력할 수 있습니다.
      </p>

      {/* 날짜 막대 — 화면 전체(근무자 칸·환경모니터링)의 기준 날짜와 일별/전체 보기 */}
      {dayBar()}

      {/* 개인별 업무표 */}
      <h2 className="text-base font-bold text-gray-700 mb-2">👥 개인별 업무표</h2>
      {/* 근무자 칸 — 인원수만큼 가로로, 사람마다 다른 색 */}
      {staff.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">직원이 없습니다. "주간근무" 메뉴의 직원 목록에서 직원을 먼저 추가하세요.</p>
      ) : (
        <div className="overflow-x-auto pb-2">
          {/* 근무자 칸은 위→아래로 [이름 / 환경모니터링 / 주기적 / 비주기적] 4개 행을 같이 쓴다 → 모든 근무자의 같은 구역 제목이 한 줄에 맞춰진다 */}
          <div className="grid gap-x-4" style={{ gridTemplateColumns: `repeat(${staff.length}, minmax(240px, 1fr))`, gridTemplateRows: 'auto auto auto minmax(60px, 1fr)' }}>
            {staff.map(who => {
              const c = colorOf(who);
              const ids = shownIds(who);
              const emIds = Object.entries(board.monAssign?.[monDate] || {}).filter(([, v]) => v.who === who);
              // 기한·완료표시는 구분이 '기타'인 업무만 쓴다 → 완료 집계도 기타 업무 기준
              const tracked = ids.filter(id => !taskById.get(id)?.kind);
              const doneCnt = tracked.filter(id => prOf(taskById.get(id), who, rotOf(taskById.get(id))).status === 'done').length;
              const over = overCol === who;
              return (
                <div key={who}
                  onDragOver={e => { if (adminUnlocked) { e.preventDefault(); setOverCol(who); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null); }}
                  onDrop={e => dropOnStaff(e, who)}
                  style={{ gridRow: 'span 4', gridTemplateRows: 'subgrid' }}
                  className={`rounded-xl border-2 grid mb-4 transition-colors ${over ? c.over : c.col}`}>
                  <div className={`px-3 py-2.5 rounded-t-[10px] flex items-center justify-between ${c.head}`}>
                    <span className="font-semibold">👤 {who}</span>
                    <span className="text-xs opacity-90">{ids.length === 0 && emIds.length === 0 ? '0건' : ids.length === 0 ? `EM ${emIds.length}건` : tracked.length ? `${doneCnt}/${tracked.length} 완료${ids.length > tracked.length ? ` · ${ids.length}건` : ''}` : `${ids.length}건`}</span>
                  </div>
                  <div className="px-2.5 pt-2.5">
                      <div className="rounded-lg border border-emerald-300 bg-emerald-50/70 p-1.5 space-y-1.5">
                        <p className="text-[11px] font-bold px-1 text-emerald-700">🌿 환경모니터링 <span className="font-normal text-gray-400">{parseInt(monDate.slice(5, 7))}/{parseInt(monDate.slice(8))}</span></p>
                        {emIds.map(([mkey, v]) => (
                          <div key={mkey} draggable={adminUnlocked} title={v.tip || ''}
                            onDragStart={e => startDrag(e, { kind: 'mon-placed', date: monDate, mkey, label: v.label, tip: v.tip })}
                            className={`rounded-lg border px-2.5 py-1.5 shadow-sm flex items-center gap-1.5 ${c.chip} ${adminUnlocked ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                            <span className="shrink-0 text-[10px] leading-none font-bold px-1.5 py-1 rounded border bg-emerald-100 border-emerald-300 text-emerald-700">EM</span>
                            <span className="flex-1 text-sm font-medium break-words">{v.label}</span>
                          </div>
                        ))}
                        {emIds.length === 0 && <p className="text-[11px] text-gray-300 px-1 py-1">없음</p>}
                      </div>
                  </div>
                    {[
                      { key: 'p', title: '🔁 주기적 업무', box: 'border-black/10 bg-white/50', head: 'text-sky-700', list: ids.filter(id => taskById.get(id)?.kind) },
                      { key: 'o', title: '📌 비주기적 업무', box: 'border-dashed border-black/20 bg-white/30', head: 'text-gray-600', list: ids.filter(id => !taskById.get(id)?.kind) },
                    ].map(sec => (
                    <div key={sec.key} className="px-2.5 pt-2 pb-0.5 last:pb-2.5">
                    <div className={`rounded-lg border p-1.5 space-y-2 h-full ${sec.box}`}>
                      <p className={`text-[11px] font-bold px-1 ${sec.head}`}>{sec.title}</p>
                    {sec.list.map(id => {
                      const t = taskById.get(id);
                      const rs = rotOf(t);
                      const track = !t.kind; // 기타 업무만 기한·완료표시
                      const pr = track ? prOf(t, who, rs) : { due: '', status: 'todo' };
                      const dl = track ? dueLabel(pr.due, pr.status) : null;
                      return (
                        <div key={id}
                          draggable={adminUnlocked}
                          onDragStart={e => startDrag(e, { kind: 'placed', taskId: id, from: who })}
                          onClick={() => openTask(t)}
                          onMouseEnter={e => showTip(e, t, who)} onMouseLeave={() => setTip(null)}
                          className={`rounded-lg border px-2.5 py-2 shadow-sm cursor-pointer ${c.chip} ${adminUnlocked ? 'active:cursor-grabbing' : ''}`}>
                          <div className="flex items-center gap-1.5">
                            <span className={`shrink-0 text-[10px] leading-none font-bold px-1.5 py-1 rounded border ${KIND_BADGE[t.kind || '']}`}>{KIND_SHORT[t.kind || '']}</span>
                            <span className={`flex-1 text-sm font-medium break-words ${pr.status === 'done' ? 'line-through opacity-60' : ''}`}>{t.name}</span>
                            {rs && <span className="text-indigo-500 text-xs leading-none">🔄</span>}
                            {track && dl && <span className={`shrink-0 text-[11px] leading-none font-bold px-1.5 py-1 rounded border ${dl.cls}`} title={`마감 ${pr.due}`}>{dl.text}</span>}
                            {track && (adminUnlocked ? (
                              <select value={pr.status} onChange={e => setProgress(who, id, { status: e.target.value })}
                                onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} draggable={false}
                                className={`shrink-0 text-[11px] font-semibold rounded border px-1 py-0.5 cursor-pointer ${STATUS_CLS[pr.status]}`}>
                                {STATUS.map(([v, l]) => <option key={v} value={v} className="bg-white text-gray-800">{l}</option>)}
                              </select>
                            ) : (
                              <span className={`shrink-0 text-[11px] font-semibold rounded border px-1.5 py-0.5 ${STATUS_CLS[pr.status]}`}>{STATUS.find(s => s[0] === pr.status)?.[1]}</span>
                            ))}
                          </div>
                          {track && pr.due && <div className="mt-1 text-[11px] text-gray-600">마감 {pr.due.slice(5).replace('-', '/')}</div>}
                        </div>
                      );
                    })}
                    {sec.list.length === 0 && <p className="text-[11px] text-gray-300 px-1 py-1">{viewMode === 'day' ? '이 날 해당 없음' : '없음'}</p>}
                    </div>
                    </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 업무배분 — 업무 버튼·환경모니터링 일정 (개인별 업무표 아래) */}
      <div
        onDragOver={e => { if (adminUnlocked) { e.preventDefault(); setOverPalette(true); } }}
        onDragLeave={() => setOverPalette(false)}
        onDrop={dropOnPalette}
        className={`rounded-xl border bg-white p-4 mt-5 mb-5 transition-colors ${overPalette ? 'border-red-300 bg-red-50/40' : 'border-gray-200'}`}
      >
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-700">📋 업무배분</span>
          {adminUnlocked && (
            <>
              <button onClick={() => openTask(null)}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">+ 업무 추가</button>
              {canImport && (
                <button onClick={importFromDuty} className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
                  title="주간근무의 매일·주간·월간 업무 중 아직 가져오지 않은 것을 업무 버튼으로 추가합니다">📥 주간근무 업무 가져오기</button>
              )}
              {board.tasks.length > 0 && (
                calOnCount > 0
                  ? <button onClick={() => setAllCalendar(false)} className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
                      title="모든 업무의 '월별 모니터링 일정에 표시'를 한 번에 끕니다">📆 달력 표시 모두 끄기 ({calOnCount})</button>
                  : <button onClick={() => setAllCalendar(true)} className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
                      title="모든 업무를 월별 모니터링 일정에 표시합니다">📆 달력 표시 모두 켜기</button>
              )}
              <span className="text-[11px] text-gray-400">버튼을 끌어서 근무자 칸에 놓으세요 · 배치된 칩을 이 영역에 놓거나 상세창의 배치 체크를 풀면 해제됩니다</span>
            </>
          )}
        </div>
        {monitoringBox()}
        {board.tasks.length === 0 ? (
          <p className="text-sm text-gray-300 py-2">{adminUnlocked ? '업무 버튼이 없습니다. 위에서 업무를 추가하거나 주간근무 업무를 가져오세요.' : '등록된 업무가 없습니다.'}</p>
        ) : (
          <div className="space-y-3">
            {[
              { key: 'periodic', title: '🔁 주기적 업무', sub: '일일·주간·월간 — 정해진 주기에 반복', box: 'border-sky-200 bg-sky-50/40', head: 'text-sky-700', list: groups.filter(g => g.kind) },
              { key: 'oneoff', title: '📌 비주기적 업무', sub: '기타 — 마감기한·완료표시로 관리', box: 'border-gray-300 bg-gray-50/70', head: 'text-gray-600', list: groups.filter(g => !g.kind) },
            ].filter(sec => sec.list.length > 0).map(sec => (
            <div key={sec.key} className={`rounded-lg border px-3 py-2.5 ${sec.box}`}>
              <p className={`text-xs font-bold mb-2 ${sec.head}`}>{sec.title} <span className="font-normal text-gray-400">{sec.sub}</span></p>
              <div className="space-y-2.5">
            {sec.list.map(g => (
              <div key={g.kind || 'etc'} className="flex items-start gap-2">
                <span className="shrink-0 w-14 text-[11px] font-semibold text-gray-400 pt-2">{KIND_LABEL[g.kind]}</span>
                <div className="flex flex-wrap gap-2">
                  {g.tasks.map(t => {
                    const ws = workersOf(t.id);
                    return (
                      <div key={t.id}
                        draggable={adminUnlocked}
                        onDragStart={e => startDrag(e, { kind: 'palette', taskId: t.id })}
                        onClick={() => openTask(t)}
                        onMouseEnter={e => showTip(e, t, null)} onMouseLeave={() => setTip(null)}
                        className={`inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg border border-gray-300 bg-gray-50 text-sm font-medium text-gray-700 select-none shadow-sm ${adminUnlocked ? 'cursor-grab active:cursor-grabbing hover:bg-white' : ''}`}>
                        {/* 구분 버튼 — 누를 때마다 일일 → 주간 → 월간 → 기타 순으로 바뀐다 */}
                        <button type="button" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setKindMenu({ id: t.id, x: r.left, y: r.bottom + 4 }); }} disabled={!adminUnlocked}
                          title={adminUnlocked ? '구분 변경 (눌러서 선택)' : KIND_LABEL[t.kind || '']}
                          className={`shrink-0 text-[10px] leading-none font-bold px-1.5 py-1 rounded border ${KIND_BADGE[t.kind || '']} ${adminUnlocked ? 'hover:brightness-95' : 'cursor-default'}`}>{KIND_SHORT[t.kind || '']}</button>
                        <span>{t.name}</span>
                        {t.kind ? <span className="text-[10px] text-gray-400 whitespace-nowrap" title="주기">⏰{scheduleLabel(t)}</span> : t.due ? <span className="text-[10px] text-gray-400 whitespace-nowrap" title="마감기한">📅마감 {t.due.slice(5).replace('-', '/')}</span> : null}
                        {t.note && <span className="text-[10px]" title={t.note}>📝</span>}
                        {t.showOnCalendar === false && <span className="text-[10px] opacity-60" title="월별 모니터링 일정에 표시하지 않음">📆✕</span>}
                        {/* 배치된 근무자를 그 사람의 색 점으로 표시 */}
                        {ws.length > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={`배치: ${ws.join(', ')}`}>
                            {ws.map(w => <span key={w} className={`w-2.5 h-2.5 rounded-full ${colorOf(w).dot}`} />)}
                          </span>
                        )}
                        {t.rotation?.on && <span className="text-[10px] px-1 rounded bg-indigo-100 text-indigo-700 font-semibold" title={`로테이션: ${rotationLabel(t.rotation)}`}>🔄 {rotationLabel(t.rotation)}</span>}
                        {adminUnlocked && (
                          <button onClick={e => { e.stopPropagation(); openTask(t); }} title="로테이션 설정 — 정한 주기마다 다른 인원에게 자동으로 넘어갑니다"
                            className={`text-xs leading-none px-0.5 ${t.rotation?.on ? 'text-indigo-600' : 'text-gray-300 hover:text-indigo-500'}`}>🔄</button>
                        )}
                        {adminUnlocked && <button onClick={e => { e.stopPropagation(); removeTask(t.id); }} className="text-gray-400 hover:text-red-500 text-xs leading-none px-0.5" title="업무 버튼 삭제">✕</button>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
              </div>
            </div>
            ))}
          </div>
        )}
      </div>

      {/* 업무 칩 툴팁 — 라벨/값을 두 칸으로 맞춰 정리해서 보여준다 */}
      {tip && !taskDlg && !kindMenu && (() => {
        const t = taskById.get(tip.id);
        if (!t) return null;
        const rs = rotOf(t);
        const who = tip.who;
        const pr = !t.kind && who ? prOf(t, who, rs) : null;
        const due = t.kind ? '' : (pr?.due || t.due || '');
        const dl = due ? dueLabel(due, pr?.status) : null;
        const ws = workersOf(t.id);
        const md = (d) => d.slice(5).replace('-', '/');
        const Row = ({ label, children }) => (
          <div className="grid grid-cols-[3.75rem_1fr] gap-x-2 items-baseline py-[3px]">
            <span className="text-[11px] text-gray-400">{label}</span>
            <div className="text-xs text-gray-100 min-w-0 break-words">{children}</div>
          </div>
        );
        return (
          <div className="fixed z-[280] w-[18.5rem] pointer-events-none rounded-xl bg-gray-900/95 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur px-3.5 py-3"
            style={{ left: tip.x, ...(tip.up ? { bottom: window.innerHeight - tip.top } : { top: tip.y }) }}>
            <div className="flex items-center gap-2 pb-2 mb-1 border-b border-white/10">
              <span className={`shrink-0 text-[10px] leading-none font-bold px-1.5 py-1 rounded border ${KIND_BADGE[t.kind || '']}`}>{KIND_SHORT[t.kind || '']}</span>
              <span className="text-sm font-semibold break-words min-w-0">{t.name}</span>
            </div>
            <Row label="담당">
              {ws.length ? (
                <span className="inline-flex flex-wrap gap-x-2.5 gap-y-0.5">
                  {ws.map(w => <span key={w} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${colorOf(w).dot}`} />{w}</span>)}
                </span>
              ) : <span className="text-gray-400">배치 없음</span>}
            </Row>
            {t.kind ? <Row label="주기">{scheduleLabel(t)}</Row> : <Row label="마감">{due ? <>{due}{dl && <span className={`ml-1.5 font-semibold ${dl.cls.includes('red') ? 'text-red-300' : dl.cls.includes('yellow') ? 'text-yellow-300' : 'text-gray-400'}`}>{dl.text}</span>}</> : <span className="text-gray-400">없음</span>}</Row>}
            {pr && <Row label="상태">{STATUS.find(x => x[0] === pr.status)?.[1]}</Row>}
            {rs && (
              <>
                <Row label="로테이션">{rotationLabel(t.rotation)}</Row>
                <Row label="이번 주기">{md(rs.startDate)} ~ {md(rs.endDate)}</Row>
                <Row label="다음 담당">
                  <div className="space-y-0.5">
                    {rs.upcoming.slice(0, 3).map(u => (
                      <div key={u.k} className="flex items-center gap-1.5">
                        <span className="text-gray-400 tabular-nums w-[2.4rem]">{md(u.startDate)}</span>
                        <span className={`w-2 h-2 rounded-full ${colorOf(u.worker).dot}`} />{u.worker}
                      </div>
                    ))}
                  </div>
                </Row>
              </>
            )}
            {t.note && <Row label="메모"><span className="whitespace-pre-wrap">{t.note.length > 120 ? t.note.slice(0, 120) + '…' : t.note}</span></Row>}
            <p className="text-[10px] text-gray-500 mt-2 pt-2 border-t border-white/10">클릭하면 상세정보{adminUnlocked ? ' · 끌어서 배치' : ''}</p>
          </div>
        );
      })()}

      {/* 구분 선택 메뉴 */}
      {kindMenu && (() => {
        const mt = taskById.get(kindMenu.id);
        return (
          <div className="fixed inset-0 z-[290]" onClick={() => setKindMenu(null)}>
            <div className="absolute bg-white rounded-lg shadow-xl border border-gray-200 py-1 w-36" style={{ left: Math.min(kindMenu.x, window.innerWidth - 160), top: kindMenu.y }} onClick={e => e.stopPropagation()}>
              {KIND_ORDER.map(k => (
                <button key={k || 'etc'} type="button" onClick={() => setKind(kindMenu.id, k)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-50 ${(mt?.kind || '') === k ? 'font-semibold text-blue-600' : 'text-gray-700'}`}>
                  <span className={`text-[10px] leading-none font-bold px-1.5 py-1 rounded border ${KIND_BADGE[k]}`}>{KIND_SHORT[k]}</span>
                  {k ? { daily: '일일점검', weekly: '주간점검', monthly: '월간점검' }[k] : '비주기(기타)'}{(mt?.kind || '') === k ? ' ✓' : ''}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 업무 상세 창 — 주간근무 목록처럼 업무명·알림시간 등을 입력한다 */}
      {taskDlg && (() => {
        const d = taskDlg.draft; const cur = taskDlg.id ? taskById.get(taskDlg.id) : null;
        const set = (patch) => setTaskDlg(p => ({ ...p, draft: { ...p.draft, ...patch } }));
        const ro = !adminUnlocked;
        const closeIt = () => setTaskDlg(null);
        return (
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={closeIt}>
            <div className="bg-white rounded-2xl shadow-2xl w-[32rem] max-w-[95vw] max-h-[92vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-bold text-gray-900 mb-3">{taskDlg.id ? '📋 업무 상세정보' : '📋 새 업무 추가'}</h3>
              <label className="block text-xs text-gray-500 mb-1">업무명</label>
              <input autoFocus={!ro} value={d.name} disabled={ro} spellCheck={false} onChange={e => set({ name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && !ro) saveTask(); if (e.key === 'Escape') closeIt(); }}
                placeholder="업무명" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-50" />
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">구분</label>
                <select value={d.kind} disabled={ro} onChange={e => set({ kind: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm disabled:bg-gray-50">
                  <option value="">기타</option><option value="daily">일일점검</option><option value="weekly">주간점검</option><option value="monthly">월간점검</option>
                </select>
              </div>
              {/* 구분에 따른 주기 설정: 일일 = 매일 몇 시 / 주간 = 무슨 요일 몇 시 / 월간 = 며칠 몇 시 */}
              {d.kind && (
                <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2.5">
                  <p className="text-xs font-semibold text-gray-600 mb-2">⏰ 주기 설정 <span className="font-normal text-gray-400">— {scheduleLabel({ kind: d.kind, alarmTime: d.alarmTime, dow: d.dow, monthDay: d.monthDay, weekdaysOnly: d.weekdaysOnly })}</span></p>
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    {d.kind === 'daily' && <span className="text-gray-600">매일</span>}
                    {d.kind === 'weekly' && (
                      <>
                        <span className="text-gray-600">매주</span>
                        <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
                          {DOW_NAMES.map((n, i) => (
                            <button key={i} type="button" disabled={ro} onClick={() => set({ dow: i })}
                              className={`px-2 py-1 text-xs font-medium border-r last:border-r-0 border-gray-300 ${(d.dow ?? 1) === i ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}>{n}</button>
                          ))}
                        </div>
                        <span className="text-gray-600">요일</span>
                      </>
                    )}
                    {d.kind === 'monthly' && (
                      <>
                        <span className="text-gray-600">매월</span>
                        <select value={d.monthDay ?? 'edge'} disabled={ro} onChange={e => set({ monthDay: e.target.value === 'edge' || e.target.value === 'last' ? e.target.value : parseInt(e.target.value) })}
                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white">
                          <option value="edge">1일과 말일</option>
                          {Array.from({ length: 31 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}일</option>)}
                          <option value="last">말일</option>
                        </select>
                      </>
                    )}
                    <input type="time" value={d.alarmTime} disabled={ro} onChange={e => set({ alarmTime: e.target.value })}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white" />
                    <span className="text-gray-600">에</span>
                  </div>
                  {d.kind === 'daily' && (
                    <label className="flex items-center gap-1.5 mt-2 text-xs text-gray-600 cursor-pointer select-none">
                      <input type="checkbox" disabled={ro} checked={d.weekdaysOnly !== false} onChange={e => set({ weekdaysOnly: e.target.checked })} /> 주말·공휴일 제외 (평일만)
                    </label>
                  )}
                </div>
              )}
              {/* 기타 업무는 주기 대신 마감기한과 완료표시를 쓴다 */}
              {!d.kind && (
                <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2.5">
                  <p className="text-xs font-semibold text-gray-600 mb-2">📅 마감기한 <span className="font-normal text-gray-400">— 완료표시는 근무자 칸의 업무에서 합니다</span></p>
                  <div className="flex items-center gap-2">
                    <input type="date" value={d.due || ''} disabled={ro} onChange={e => set({ due: e.target.value })}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white disabled:bg-gray-50" />
                    {d.due && !ro && <button type="button" onClick={() => set({ due: '' })} className="text-xs text-gray-500 px-2 py-1 rounded hover:bg-gray-200">지우기</button>}
                    {!d.due && <span className="text-[11px] text-gray-400">정하지 않으면 마감 없음{d.rot?.on ? '(로테이션이면 주기 끝날)' : ''}</span>}
                  </div>
                </div>
              )}
              <label className={`flex items-center gap-1.5 mb-3 text-sm text-gray-700 select-none ${ro ? 'opacity-60' : 'cursor-pointer'}`}>
                <input type="checkbox" disabled={ro} checked={d.showCal !== false} onChange={e => set({ showCal: e.target.checked })} />
                📆 월별 모니터링 일정에 표시
              </label>
              <label className="block text-xs text-gray-500 mb-1">메모</label>
              <textarea value={d.note} disabled={ro} rows={4} spellCheck={false} onChange={e => set({ note: e.target.value })}
                placeholder="업무 내용·주의사항 등" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-50" />
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">배치 <span className="text-gray-400">— 체크한 근무자에게 배정됩니다 (끌어다 놓아도 됩니다)</span></p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {staff.map(w => (
                    <label key={w} className={`inline-flex items-center gap-1.5 text-sm select-none ${ro ? 'opacity-50' : 'cursor-pointer'}`}>
                      <input type="checkbox" disabled={ro}
                        checked={d.rot.on && cur?.rotation?.on ? (d.curWorker || workersOf(cur.id)[0]) === w : d.assign.includes(w)}
                        onChange={e => { if (d.rot.on && cur?.rotation?.on) { if (e.target.checked) set({ curWorker: w }); } else set({ assign: e.target.checked ? [...d.assign, w] : d.assign.filter(x => x !== w) }); }} />
                      <span className={`w-2.5 h-2.5 rounded-full ${colorOf(w).dot}`} />{w}
                    </label>
                  ))}
                </div>
                {d.rot.on && <p className="text-[11px] text-indigo-500 mt-1">{cur?.rotation?.on ? '로테이션 중에는 이번 주기 담당 한 명만 고를 수 있고, 바꾸면 다음 순서가 그 사람부터 이어집니다.' : '로테이션을 켜면 주기마다 담당이 자동으로 정해집니다(체크한 첫 사람이 1주기 담당).'}</p>}
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100">
                <p className="text-sm font-semibold text-gray-700 mb-2">🔄 로테이션</p>
                <div className={ro ? 'pointer-events-none opacity-70' : ''}>{rotationForm({ ...(cur || {}), id: taskDlg.id }, d.rot, (patch) => set({ rot: { ...d.rot, ...patch } }))}</div>
              </div>
              <div className="flex gap-2 justify-end mt-4">
                {!ro && cur && <button onClick={() => { closeIt(); removeTask(cur.id); }} className="mr-auto px-3 py-2 text-sm text-red-600 bg-red-50 rounded-lg hover:bg-red-100">삭제</button>}
                <button onClick={closeIt} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">{ro ? '닫기' : '취소'}</button>
                {!ro && <button onClick={saveTask} disabled={!d.name.trim()} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40">{taskDlg.id ? '저장' : '추가'}</button>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
