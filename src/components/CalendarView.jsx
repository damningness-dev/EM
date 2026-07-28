import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, upsertZone, fetchGroups, upsertGroup, deleteGroup, fetchHolidays, upsertHoliday, deleteHoliday, fetchCompletions, setCompletion, deleteCompletion, fetchTempSchedules, addTempSchedule, deleteTempSchedule, updateTempSchedule, fetchScheduleConfig, saveScheduleConfig, backfillZonePointsFromMonitoring, fetchBlockedDates, setBlockedDate, fetchTodos, upsertTodo, deleteTodo, syncGetConfig, syncUpload, exportScheduleExcelTable, printDoc } from '../lib/api';
import { parseISO, differenceInDays, format } from 'date-fns';
import { calcMeasurements, calcEndDate, totalCount, getDragBounds, NEXT_GRADE, GRADE_PRIORITY, NTH_LABEL, DOW_LABEL, buildHolidayMap, computeCascadeSchedules, optimizeMonthSchedule, setScheduleConfig, DEFAULT_SCHEDULE_SPECS, MAJOR_CATS, getMajorCat, isCombinedCat } from '../lib/schedule';
import { GRADE_COLORS, CATEGORY_SECTION } from '../data/initialData';
import { lunarToSolar } from '../lib/lunar';
import { effectiveCalib } from '../utils/calibUtils';
import OrderGroupManager from './OrderGroupManager';

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const TYPE_COLORS = {
  daily:    'bg-red-100 text-red-700 border border-red-200',
  weekly:   'bg-blue-100 text-blue-700 border border-blue-200',
  biweekly: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  monthly:  'bg-violet-100 text-violet-700 border border-violet-200',
};

const CAT_CHIP_BG = {
  '공조':   'bg-white border border-gray-300',
  '질소가스': 'bg-purple-100 border border-purple-200',
  '압축공기': 'bg-yellow-100 border border-yellow-200',
};
const GRADE_CHIP_TEXT = {
  'P1': 'text-red-700',
  'P2': 'text-green-700',
  'P3': 'text-blue-700',
  '유지관리': 'text-indigo-900',
};

const TYPE_LABEL = { daily: '일1회', weekly: '주1회', biweekly: '격주', monthly: '월1회' };

// 측정주기 설정 — 유형 옵션 / 기본 간격
const CYCLE_TYPES = [
  { value: 'daily',     label: '매일(일1회)' },
  { value: 'weekly',    label: '주1회' },
  { value: 'biweekly',  label: '격주(2주)' },
  { value: 'monthly',   label: '월1회' },
  { value: 'quarterly', label: '분기1회(3개월)' },
];
const DEFAULT_INTERVAL = { daily: 1, weekly: 7, biweekly: 14, monthly: null, quarterly: null };
const CYCLE_GRADES = ['P1', 'P2', 'P3', '유지관리'];
const CYCLE_CATS = ['공조', '압축공기', '질소가스', '용수'];

function mergeScheduleConfig(backend) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_SPECS));
  if (backend && typeof backend === 'object') {
    // 백엔드의 모든 분류(기본 + 사용자가 추가한 소분류)를 반영한다.
    for (const cat of Object.keys(backend)) {
      if (!base[cat]) base[cat] = {};
      const src = backend[cat];
      if (src && typeof src === 'object') {
        // __major 등 메타 키 보존 + 등급별 구간 병합
        for (const key of Object.keys(src)) {
          if (Array.isArray(src[key]) || key.startsWith('__')) base[cat][key] = src[key];
        }
      }
    }
  }
  return base;
}

const DEFAULT_CHIP_COLORS = {
  'cat_공조':       { bg: '#ffffff', border: '#d1d5db' },
  'cat_질소가스':   { bg: '#f3e8ff', border: '#e9d5ff' },
  'cat_압축공기':   { bg: '#fef9c3', border: '#fde68a' },
  'cat_용수':       { bg: '#ccfbf1', border: '#99f6e4' },
  'grade_P1':       { text: '#b91c1c' },
  'grade_P2':       { text: '#15803d' },
  'grade_P3':       { text: '#1d4ed8' },
  'grade_유지관리': { text: '#312e81' },
};

function buildGrid(year, month, weekStart = 'mon') {
  // leading blanks = days from the week-start weekday up to the 1st.
  const firstDow = new Date(year, month - 1, 1).getDay();
  const lead = weekStart === 'sun' ? firstDow : (firstDow + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthDays = new Date(prevYear, prevMonth, 0).getDate();
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  const cells = [];
  for (let i = lead - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, year: prevYear, month: prevMonth, isOther: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, year, month, isOther: false });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: nextDay++, year: nextYear, month: nextMonth, isOther: true });
  }
  return cells;
}

export default function CalendarView({ year: initYear, onYearChange, adminUnlocked }) {
  const today = new Date();
  const [year, setYear] = useState(initYear || today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState(null);
  const [monTab, setMonTab] = useState('all'); // 모니터링 현황 탭: all | done | pending

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);
  const [showOrderManager, setShowOrderManager] = useState(false);
  const [dragOverDay, setDragOverDay] = useState(null);
  // 오류/성공 알림을 각각 하나만 유지하던 방식(toast/successToast)은 긴 오류 메시지가
  // 뒤에 뜨는 성공 알림(예: 일정 변경 알람)에 가려지는 문제가 있었다. 여러 개를
  // 겹치지 않게 세로로 쌓아 각자 독립적으로 표시/소멸되도록 큐 형태로 관리한다.
  const [toasts, setToasts] = useState([]); // [{ id, type:'error'|'success', message }]
  const [groups, setGroups] = useState([]);
  const [phasePrompt, setPhasePrompt] = useState(null); // { zoneId, zoneName, nextGrade, dateStr }
  const [newGroupName, setNewGroupName] = useState('');
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayRepeat, setNewHolidayRepeat] = useState(false);
  const [newHolidaySubstitute, setNewHolidaySubstitute] = useState(false);
  const [newHolidayLunar, setNewHolidayLunar] = useState(false);
  const [newHolidayBridgeBefore, setNewHolidayBridgeBefore] = useState(0);
  const [newHolidayBridgeAfter, setNewHolidayBridgeAfter] = useState(0);
  const [newHolidayRepeatType, setNewHolidayRepeatType] = useState('yearly');
  const [newHolidayNth, setNewHolidayNth] = useState(1);
  const [newHolidayDow, setNewHolidayDow] = useState(1);
  const [completions, setCompletions] = useState(new Set());
  const [completionPrompt, setCompletionPrompt] = useState(null); // {zoneId,zoneName,grade,num,dateStr,isCompleted}
  const [groupMovePrompt, setGroupMovePrompt] = useState(null); // { dateStr, dragData, groupName, members:[{zoneId,num,min,max,label}] }
  const [todos, setTodos] = useState([]); // 할일 (측정 알람 추가 상태 확인용)
  const [tempSchedules, setTempSchedules] = useState([]);
  const [blockedDates, setBlockedDates] = useState(new Set()); // 일정비우기 날짜('yyyy-MM-dd')

  // ── 일정 초안(저장하기 전까지 미반영) ──
  // 측정일 이동/시작일 재설정/일정비우기/임시일정/일정 최적화는 로컬 상태만 바꾸고,
  // "일정 저장하기"를 눌러야 실제로 저장된다. "되돌리기"는 마지막 저장 시점으로 전체 복원한다.
  const savedSnapshotRef = useRef(null); // { zones, blockedDates, tempSchedules } (마지막 저장 상태)
  const pendingTempDeletesRef = useRef([]); // 저장 시 함께 삭제할 임시일정 id
  const [changeLog, setChangeLog] = useState([]); // [{ id, msg }] 미저장 변경 내역
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [changeSummary, setChangeSummary] = useState(null); // 저장 직후 보여줄 변경 내역 팝업 (string[])
  const [saveSyncNote, setSaveSyncNote] = useState(null); // 저장 직후 공유 동기화 업로드 결과 메시지
  const CHANGE_HISTORY_KEY = 'em-schedule-change-history';
  const CHANGE_HISTORY_MAX = 50;
  const [changeHistory, setChangeHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHANGE_HISTORY_KEY)) || []; } catch { return []; }
  }); // [{ ts, changes:[msg,...] }] 저장할 때마다 누적되는 일정변경 알람 내역 (이 PC에 보관)
  const [showChangeHistory, setShowChangeHistory] = useState(false);

  function recordChangeHistory(changes) {
    setChangeHistory(prev => {
      const next = [{ ts: new Date().toISOString(), changes, source: 'local' }, ...prev].slice(0, CHANGE_HISTORY_MAX);
      try { localStorage.setItem(CHANGE_HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function logChange(msg) {
    setChangeLog(prev => [...prev, { id: `${prev.length}-${Math.random().toString(36).slice(2)}`, msg }]);
  }

  // 같은 항목(key)을 저장 전에 여러 번 옮기면(예: 6일→7일→8일) 매번 별도 항목으로
  // 남기지 않고, 항상 "최초 시작 위치 → 최종 위치" 한 건으로만 남긴다. 원래
  // 위치로 되돌아오면(6일→7일→6일) 실질적인 변경이 없으므로 항목 자체를 지운다.
  function logMoveChange(key, label, from, to, suffix = '') {
    setChangeLog(prev => {
      const idx = prev.findIndex(e => e.key === key);
      if (idx >= 0) {
        const origFrom = prev[idx].from;
        if (String(origFrom) === String(to)) return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        const merged = { ...prev[idx], to, msg: `${label}: ${origFrom} → ${to}${suffix}` };
        return [...prev.slice(0, idx), merged, ...prev.slice(idx + 1)];
      }
      if (String(from) === String(to)) return prev;
      return [...prev, { id: `${prev.length}-${Math.random().toString(36).slice(2)}`, key, from, to, msg: `${label}: ${from} → ${to}${suffix}` }];
    });
  }
  // changeLog를 마운트-1회성 effect(useEffect(...,[]))의 클로저에서도 최신값으로 읽기 위한 ref
  const changeLogRef = useRef([]);
  useEffect(() => { changeLogRef.current = changeLog; }, [changeLog]);

  const [addSchedPopup, setAddSchedPopup] = useState(null); // { date }
  const [addSchedName, setAddSchedName] = useState('');
  const [addSchedPts, setAddSchedPts] = useState({ surface: '', float: '', fall: '', particle: '' });
  const [editingTempId, setEditingTempId] = useState(null); // 임시일정 이름 수정 중인 id
  const [editingTempName, setEditingTempName] = useState('');
  const [deleteTempPrompt, setDeleteTempPrompt] = useState(null); // 삭제 확인 대기 중인 임시일정
  const [chipColors, setChipColors] = useState(() => {
    try {
      const saved = localStorage.getItem('em-chip-colors');
      return saved ? { ...DEFAULT_CHIP_COLORS, ...JSON.parse(saved) } : { ...DEFAULT_CHIP_COLORS };
    } catch { return { ...DEFAULT_CHIP_COLORS }; }
  });
  const [colorPicker, setColorPicker] = useState(null); // { key, label, type:'cat'|'grade', x, y }
  const colorPickerRef = useRef(null);
  const printAreaRef = useRef(null); // 인쇄 영역 — 인쇄 직전 크기를 재서 한 페이지에 맞게 축소
  const [optimizePopup, setOptimizePopup] = useState(false);
  const [viewMode, setViewMode] = useState('calendar'); // 'calendar' | 'table'
  const [optimizeCapacities, setOptimizeCapacities] = useState(() => {
    try {
      const saved = localStorage.getItem('em-daily-capacities');
      return saved ? JSON.parse(saved) : { surface: '', float: '', fall: '', particle: '', combined: '' };
    } catch { return { surface: '', float: '', fall: '', particle: '', combined: '' }; }
  });
  const [optimizing, setOptimizing] = useState(false);
  const [calSettingsPopup, setCalSettingsPopup] = useState(false);
  const [weekStart, setWeekStart] = useState(() => {
    try { return localStorage.getItem('em-week-start') || 'mon'; } catch { return 'mon'; }
  });
  const [scheduleConfig, setScheduleConfigState] = useState(() => mergeScheduleConfig(null));
  const [cycleCatTab, setCycleCatTab] = useState('공조');

  function applyScheduleConfig(nextCfg) {
    setScheduleConfig(nextCfg);          // 모듈 변수 즉시 반영(계산 함수가 최신값 사용)
    setScheduleConfigState(nextCfg);     // 상태 변경 → 달력 재계산
    saveScheduleConfig(nextCfg);         // 영구 저장
  }

  function editCyclePhase(cat, grade, idx, field, value) {
    const next = JSON.parse(JSON.stringify(scheduleConfig));
    const phase = next[cat][grade][idx];
    if (field === 'type') {
      phase.type = value;
      if (value === 'monthly' || value === 'quarterly') phase.intervalDays = null;
      else if (phase.intervalDays == null) phase.intervalDays = DEFAULT_INTERVAL[value];
    } else if (field === 'count') {
      phase.count = Math.max(1, parseInt(value) || 1);
    } else if (field === 'intervalDays') {
      phase.intervalDays = Math.max(1, parseInt(value) || 1);
    }
    applyScheduleConfig(next);
  }

  function addCyclePhase(cat, grade) {
    const next = JSON.parse(JSON.stringify(scheduleConfig));
    if (!next[cat][grade]) next[cat][grade] = [];
    next[cat][grade].push({ count: 1, intervalDays: 14, type: 'biweekly' });
    applyScheduleConfig(next);
  }

  function removeCyclePhase(cat, grade, idx) {
    const next = JSON.parse(JSON.stringify(scheduleConfig));
    next[cat][grade].splice(idx, 1);
    applyScheduleConfig(next);
  }

  function resetCycleCategory(cat) {
    const next = JSON.parse(JSON.stringify(scheduleConfig));
    next[cat] = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_SPECS[cat]));
    applyScheduleConfig(next);
  }

  function changeWeekStart(value) {
    setWeekStart(value);
    try { localStorage.setItem('em-week-start', value); } catch {}
  }

  const holidays = useMemo(() => buildHolidayMap(holidayDefs, year - 1, year + 1), [holidayDefs, year]);

  // 일정 계산용 회피 맵: 공휴일 + 일정비우기(차단) 날짜 → 자동 배치가 해당일을 피함
  const scheduleAvoid = useMemo(() => {
    const m = { ...holidays };
    blockedDates.forEach(d => { if (!m[d]) m[d] = '일정비우기'; });
    return m;
  }, [holidays, blockedDates]);

  // 구역/그룹/공휴일/완료/임시일정/측정주기설정/일정비우기는 월·연도와 무관한 전역 데이터라
  // 마운트 시 한 번만 불러온다. (매번 다시 불러오면 저장하지 않은 일정 초안이 사라지므로)
  useEffect(() => {
    Promise.all([
      fetchZones(),
      fetchGroups(),
      fetchHolidays(),
      fetchCompletions(),
      fetchTempSchedules(),
      fetchScheduleConfig(),
      fetchBlockedDates(),
    ]).then(([zns, grps, hols, comps, temps, schedCfg, blocked]) => {
      const mergedCfg = mergeScheduleConfig(schedCfg);
      setScheduleConfig(mergedCfg);
      setScheduleConfigState(mergedCfg);
      // 레거시 '청정등급' 분류 → '공조'로 이관 (청정등급은 이제 각 일정의 속성)
      const legacy = zns.filter(z => z.category === '청정등급');
      if (legacy.length) {
        legacy.forEach(z => upsertZone({ ...z, category: '공조' }));
        zns = zns.map(z => z.category === '청정등급' ? { ...z, category: '공조' } : z);
      }
      const blockedSet = new Set(blocked || []);
      setZones(zns);
      setGroups(grps);
      setHolidayDefs(hols);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
      setTempSchedules(temps);
      setBlockedDates(blockedSet);
      savedSnapshotRef.current = { zones: zns, blockedDates: blockedSet, tempSchedules: temps };
      // 월별 모니터링에 입력한 측정포인트를 구역 points_*로 backfill (비어있는 구역만)
      backfillZonePointsFromMonitoring(zns, [year - 1, year, year + 1])
        .then(({ zones: filled, changed }) => {
          if (changed) {
            setZones(filled);
            if (savedSnapshotRef.current) savedSnapshotRef.current.zones = filled;
          }
        })
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 달력에 표시할 월별 데이터(교정/모니터링 실적/AHU 계획)는 월 이동 시마다 새로 불러온다.
  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    Promise.all([
      fetchCalibration(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
    ]).then(([cal, mon, plan]) => {
      setCalibration(cal);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [year, month]);

  // 순서/그룹 관리 — Electron 별도 창(항상 위) 우선, 없으면 인앱 오버레이
  function openOrderManagerPopup() {
    if (!requireAdmin()) return;
    if (window.electronAPI?.openOrderManager) {
      window.electronAPI.openOrderManager();
    } else {
      setShowOrderManager(true);
    }
  }

  // 화면에 보이는 데이터 전체를 다시 불러온다 (별도 창 저장 또는 공유 동기화로 데이터가
  // 바뀌었을 때 호출됨) — 이전에는 구역/그룹/공휴일만 새로고침해서 공유 동기화로 받은
  // 교정·완료·임시일정·일정비우기 등은 다른 화면에 갔다 와야만(재마운트) 반영됐다.
  // 저장하지 않은 일정 초안(측정일 이동 등)이 있으면 그 초안이 걸린 구역/일정비우기/
  // 임시일정은 덮어쓰지 않는다 (초안 유실 방지). 나머지는 초안과 무관하므로 항상 반영.
  async function reloadZonesGroups() {
    try {
      const [zns, grps, hols, comps, temps, blocked, cal, mon, plan, schedCfg, tds] = await Promise.all([
        fetchZones(), fetchGroups(), fetchHolidays(), fetchCompletions(), fetchTempSchedules(),
        fetchBlockedDates(), fetchCalibration(), fetchMonitoringData(year, month), fetchAnnualPlan(year),
        fetchScheduleConfig(), fetchTodos(),
      ]);
      setGroups(grps);
      setHolidayDefs(hols);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
      setCalibration(cal);
      setMonitoring(mon);
      setAnnualPlan(plan);
      if (schedCfg) {
        const merged = mergeScheduleConfig(schedCfg);
        setScheduleConfig(merged);
        setScheduleConfigState(merged);
      }
      setTodos(tds);
      if (changeLogRef.current.length > 0) {
        showError('저장하지 않은 일정 변경사항이 있어 외부 변경 내용을 반영하지 않았습니다. 저장하거나 되돌린 뒤 새로고침하세요.');
        return;
      }
      const blockedSet = new Set(blocked || []);
      setZones(zns);
      setBlockedDates(blockedSet);
      setTempSchedules(temps);
      savedSnapshotRef.current = { zones: zns, blockedDates: blockedSet, tempSchedules: temps };
    } catch { /* ignore */ }
  }

  // 별도 창에서 데이터 변경 시, 또는 공유 동기화로 원격 변경을 받아왔을 때 메인 창 새로고침.
  // year/month가 바뀌면 재구독해 reloadZonesGroups가 항상 현재 보고 있는 달 기준으로 동작하게 한다.
  useEffect(() => {
    if (!window.electronAPI?.onDataChanged) return;
    return window.electronAPI.onDataChanged(() => { reloadZonesGroups(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  // 할일(측정 알람) 로드
  useEffect(() => { fetchTodos().then(setTodos).catch(() => {}); }, []);

  // 측정 → 할일 srcKey (중복 방지)
  const measTodoKey = (zone, m, dateStr) => `meas:${zone.id}:${m.num}:${dateStr}`;
  const hasMeasTodo = (zone, m, dateStr) => todos.some(t => t.srcKey === measTodoKey(zone, m, dateStr));

  // 측정 일정을 그 날의 할일(알람)로 추가/해제 토글
  async function toggleMeasTodo(zone, m, dateStr) {
    // 할일 알람 추가/해제는 개인 로컬 할일일 뿐 공유 일정을 바꾸지 않으므로
    // 관리자 잠금 해제 없이도 사용할 수 있게 한다.
    const key = measTodoKey(zone, m, dateStr);
    const existing = todos.find(t => t.srcKey === key);
    if (existing) {
      await deleteTodo(existing.id);
      setTodos(prev => prev.filter(t => t.id !== existing.id));
    } else {
      const todo = {
        title: `${zone.name}[${zone.grade}] ${m.num}회차 측정`,
        date: dateStr, time: '09:00', alarmEnabled: true, repeat: 'none', interval: 1,
        note: '측정 일정 알람', srcKey: key, completedDates: [],
      };
      const saved = await upsertTodo(todo);
      setTodos(prev => [...prev, saved]);
    }
    window.electronAPI?.notifyDataChanged?.();
  }

  // 해당 날짜의 모든 측정을 한 번에 할일(알람)로 추가
  async function addAllMeasTodos(dateStr) {
    const evts = scheduleByDate[dateStr] || [];
    const toAdd = evts.filter(({ zone, measurement }) => !hasMeasTodo(zone, measurement, dateStr));
    if (toAdd.length === 0) { showSuccess('이미 모든 일정이 할일에 추가되어 있습니다.'); return; }
    const added = [];
    for (const { zone, measurement } of toAdd) {
      try {
        const saved = await upsertTodo({
          title: `${zone.name}[${zone.grade}] ${measurement.num}회차 측정`,
          date: dateStr, time: '09:00', alarmEnabled: true, repeat: 'none', interval: 1,
          note: '측정 일정 알람', srcKey: measTodoKey(zone, measurement, dateStr), completedDates: [],
        });
        added.push(saved);
      } catch { /* ignore */ }
    }
    setTodos(prev => [...prev, ...added]);
    window.electronAPI?.notifyDataChanged?.();
    showSuccess(`${added.length}건을 할일 알람(09:00)에 추가했습니다.`);
  }

  // 관리자 잠금 해제 상태(adminUnlocked)가 아니면 일정 변경/일정 관리 권한이 모두 막힌다.
  // 허용: 월별 이동, 표/달력 보기 전환, 일정 클릭 시 해당일 일정목록 확인(읽기 전용).
  function requireAdmin() {
    if (!adminUnlocked) { showError('관리자 잠금 해제가 필요합니다.'); return false; }
    return true;
  }

  useEffect(() => {
    if (!colorPicker) return;
    function onMouseDown(e) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target)) setColorPicker(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [colorPicker]);

  function prevMonth() {
    if (month === 1) { const y = year - 1; setYear(y); onYearChange?.(y); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { const y = year + 1; setYear(y); onYearChange?.(y); setMonth(1); }
    else setMonth(m => m + 1);
  }

  // Calibration events by date string — 연도별 교정내역이 있으면 최신 내역(effectiveCalib)
  // 기준으로 표시해, 상단 필드만 예전 값으로 남아있는 항목도 항상 최신 차기교정일로 뜨게 한다.
  const calibByDate = {};
  calibration.forEach(c => {
    const eff = effectiveCalib(c);
    if (!eff.next_calib_date || eff.next_calib_date === '미사용') return;
    try {
      const key = eff.next_calib_date.slice(0, 10);
      if (!calibByDate[key]) calibByDate[key] = [];
      calibByDate[key].push({ ...c, ...eff });
    } catch {}
  });

  // 일정관리(순서/그룹 관리)와 동일한 정렬 기준으로 구역별 순위 계산
  // - 구역명 그룹 단위로 묶고, 그룹은 최소 sort_order(동률이면 이름), 그룹 내는 등급 우선순위
  const zoneOrderRank = useMemo(() => {
    const groups = {};
    zones.forEach(z => {
      const key = `${z.category}|||${z.name}`;
      (groups[key] || (groups[key] = { name: z.name, zones: [] })).zones.push(z);
    });
    const arr = Object.values(groups);
    arr.forEach(g => g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)));
    arr.sort((a, b) =>
      (Math.min(...a.zones.map(z => z.sort_order ?? 1e9)) - Math.min(...b.zones.map(z => z.sort_order ?? 1e9)))
      || a.name.localeCompare(b.name)
    );
    const rank = {};
    let i = 0;
    arr.forEach(g => g.zones.forEach(z => { rank[z.id] = i++; }));
    return rank;
  }, [zones]);

  // Schedule events by date string (all dates, no month filter)
  const scheduleByDate = useMemo(() => {
    const map = {};
    // 같은 구역명(분류+이름)의 서로 다른 등급(P1/P2/P3/유지관리)이 같은 날에
    // 겹치지 않도록, 구역명 그룹 단위로 공유 usedDates Set을 사용한다.
    // 시간순(시작일 → 등급 우선순위 P1먼저)으로 처리해 앞선 일정이 자리를 먼저 잡고
    // 뒤 일정이 밀려나도록 한다.
    const byName = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const key = `${zone.category}|||${zone.name}`;
      (byName[key] || (byName[key] = [])).push(zone);
    });
    Object.values(byName).forEach(groupZones => {
      groupZones.sort((a, b) =>
        (a.schedule_start || '').localeCompare(b.schedule_start || '')
        || (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)
      );
      const used = new Set();
      groupZones.forEach(zone => {
        calcMeasurements(zone, scheduleAvoid, used).forEach(m => {
          const key = format(m.date, 'yyyy-MM-dd');
          if (!map[key]) map[key] = [];
          map[key].push({ zone, measurement: m });
        });
      });
    });
    // 일정관리 전체 순서(zoneOrderRank) 기준 정렬 — 일정을 이동해도 순서 유지
    Object.values(map).forEach(arr => arr.sort((a, b) =>
      (zoneOrderRank[a.zone.id] ?? 1e9) - (zoneOrderRank[b.zone.id] ?? 1e9) || a.zone.name.localeCompare(b.zone.name)
    ));
    return map;
  }, [zones, scheduleAvoid, scheduleConfig, zoneOrderRank]);

  // 특정 구역/회차가 (이동 전) 현재 어느 날짜에 배치돼 있는지 조회 — 변경 알람에 "이전 날짜"를 표시하기 위함
  function currentDateOf(zoneId, num) {
    for (const [ds, arr] of Object.entries(scheduleByDate)) {
      if (arr.some(ev => String(ev.zone.id) === String(zoneId) && ev.measurement.num === num)) return ds;
    }
    return null;
  }

  // 표로보기: 이번 달 측정 일정을 날짜순 목록으로
  const monthTableRows = useMemo(() => {
    const prefix = `${year}-${String(month).padStart(2, '0')}-`;
    const rows = [];
    Object.entries(scheduleByDate).forEach(([ds, arr]) => {
      if (!ds.startsWith(prefix)) return;
      arr.forEach(({ zone, measurement }) => rows.push({ ds, zone, measurement }));
    });
    rows.sort((a, b) => a.ds.localeCompare(b.ds)
      || (zoneOrderRank[a.zone.id] ?? 1e9) - (zoneOrderRank[b.zone.id] ?? 1e9));
    return rows;
  }, [scheduleByDate, year, month, zoneOrderRank]);

  // 엑셀(CSV)로 내보내기 — 이번 달 표 보기와 동일한 컬럼 구성
  function handleExportExcel() {
    const DOW = ['일', '월', '화', '수', '목', '금', '토'];
    const columns = [
      { label: '날짜', width: 12 }, { label: '요일', width: 6 }, { label: '구분', width: 22 }, { label: '회차', width: 8 },
      { label: '부유균', width: 9 }, { label: '낙하균', width: 9 }, { label: '표면균', width: 9 }, { label: '부유입자', width: 9 },
      { label: '질소', width: 8 }, { label: '압축', width: 8 }, { label: '완료여부', width: 10 },
    ];
    const rows = monthTableRows.map(({ ds, zone, measurement }) => {
      const d = new Date(ds + 'T00:00:00');
      const done = completions.has(`${zone.id}_${measurement.num}`);
      return [
        ds, DOW[d.getDay()], `${zone.name}[${zone.grade}]`, measurement.num,
        ptValue(zone, 'float') || '', ptValue(zone, 'fall') || '', ptValue(zone, 'surface') || '', ptValue(zone, 'particle') || '',
        ptValue(zone, 'nitro') || '', ptValue(zone, 'comp') || '',
        done ? '완료' : '예정',
      ];
    });
    const filename = `모니터링일정_${year}${String(month).padStart(2, '0')}.xlsx`;
    // "표 스타일 보통 16"(TableStyleMedium16) 서식이 적용된 엑셀 표로 내보낸다.
    exportScheduleExcelTable({
      defaultName: filename,
      sheetName: `${year}년 ${month}월`,
      tableStyle: 'TableStyleMedium16',
      columns, rows,
    }).then(r => {
      if (r?.ok) showSuccess(`엑셀 파일로 내보냈습니다: ${r.filePath}`);
      else if (!r?.canceled) showError('내보내기 실패: ' + (r?.error || ''));
    });
  }

  // 인쇄 — 현재 보고 있는 화면(달력보기/표보기) 그대로 가로 한 페이지에 인쇄한다.
  // 달력/표 카드만 body 최상단에 복제해두고 원본 앱(#root)은 인쇄 시 숨겨,
  // 안 보이는 사이드바 등이 빈 페이지를 만들지 않게 한다(2장 출력 방지).
  // Windows 인쇄 대화상자가 가로 방향을 무시하는 문제 때문에, Electron에서는
  // 가로·배경색이 확정된 A4 PDF로 만들어 기본 뷰어로 연다(항상 가로 출력).
  // 인쇄 레이아웃(고정 폭·셀 클리핑)은 index.css의 @media print에서 처리.
  async function handlePrint() {
    const src = printAreaRef.current;
    if (!src) { window.print(); return; }
    const portal = document.createElement('div');
    portal.className = 'print-portal';
    const clone = src.cloneNode(true);
    clone.style.transform = 'none';
    portal.appendChild(clone);
    document.body.appendChild(portal);
    document.body.classList.add('is-printing');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove('is-printing');
      portal.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    if (window.electronAPI) {
      // 렌더 안정화를 위해 한 프레임 뒤 PDF 생성
      await new Promise(r => requestAnimationFrame(() => r()));
      try {
        const res = await printDoc({ landscape: true, pageSize: 'A4' });
        if (res && res.ok) showSuccess('가로 PDF로 열었습니다. 뷰어에서 인쇄(Ctrl+P)하면 가로로 출력됩니다.');
        else showError('인쇄 준비 실패: ' + (res?.error || ''));
      } catch (e) { showError('인쇄 준비 실패: ' + e.message); }
      cleanup();
    } else {
      window.addEventListener('afterprint', cleanup);
      try { window.print(); } finally { setTimeout(cleanup, 3000); }
    }
  }

  const tempByDate = useMemo(() => {
    const map = {};
    tempSchedules.forEach(t => {
      if (!map[t.date]) map[t.date] = [];
      map[t.date].push(t);
    });
    return map;
  }, [tempSchedules]);

  // Group zones by (category, name) for settings drawer
  const zoneGroups = useMemo(() => {
    const groupMap = {};
    zones.forEach(zone => {
      const key = `${zone.category}|||${zone.name}`;
      if (!groupMap[key]) groupMap[key] = { name: zone.name, category: zone.category, zones: [] };
      groupMap[key].zones.push(zone);
    });
    Object.values(groupMap).forEach(g => {
      g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
    });
    return Object.values(groupMap);
  }, [zones]);

  // Monitoring stats
  const completedCount = zones.filter(z => monitoring[z.id]).length;
  const monRate = zones.length ? Math.round(completedCount / zones.length * 100) : 0;

  // AHU tasks this month
  const allAhuEntries = Object.entries(annualPlan)
    .filter(([, val]) => val.planned)
    .map(([key, val]) => {
      const parts = key.split('_');
      const taskMonth = parseInt(parts[parts.length - 1]);
      const ahuName = parts.slice(0, -1).join('_');
      return { ahuName, month: taskMonth, done: val.done };
    });
  const ahuTasksWithNth = allAhuEntries.map(t => ({
    ...t,
    nth: allAhuEntries.filter(e => e.ahuName === t.ahuName && e.month <= t.month).length,
  }));
  const ahuTasks = ahuTasksWithNth.sort((a, b) => {
    const aOff = a.month >= month ? a.month - month : a.month + 12 - month;
    const bOff = b.month >= month ? b.month - month : b.month + 12 - month;
    return aOff - bOff || a.ahuName.localeCompare(b.ahuName);
  });
  const currentMonthAhuTasks = ahuTasks.filter(t => t.month === month);

  const curMonthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const totalMonthSchedule = Object.entries(scheduleByDate)
    .filter(([k]) => k.startsWith(curMonthPrefix))
    .reduce((sum, [, arr]) => sum + arr.length, 0);
  const calibThisMonthCount = Object.keys(calibByDate).filter(k => k.startsWith(curMonthPrefix)).length;

  // 모니터링 현황 패널: 이번 달 측정 일정(회차 단위)을 완료/예정으로 나눠 탭으로 보여준다.
  const monthDoneRows = monthTableRows.filter(r => completions.has(`${r.zone.id}_${r.measurement.num}`));
  const monthPendingRows = monthTableRows.filter(r => !completions.has(`${r.zone.id}_${r.measurement.num}`));
  const monCompleteRate = monthTableRows.length ? Math.round(monthDoneRows.length / monthTableRows.length * 100) : 0;

  // 구역별로 묶어서 보여준다 — 같은 구역이 이번 달에 여러 번 측정되면(측정주기가
  // 짧은 구역) 이번 달 기준 순번/총회차를 "1/2"처럼 표시한다(전체 일정의 회차
  // 번호가 아니라 이번 달 안에서의 순번).
  const monthZoneGroups = useMemo(() => {
    const byZone = new Map();
    monthTableRows.forEach(r => {
      if (!byZone.has(r.zone.id)) byZone.set(r.zone.id, { zone: r.zone, occurrences: [] });
      byZone.get(r.zone.id).occurrences.push(r);
    });
    const groups = [...byZone.values()].map(g => {
      const sorted = [...g.occurrences].sort((a, b) => a.ds.localeCompare(b.ds));
      return { zone: g.zone, occurrences: sorted.map((occ, i) => ({ ...occ, monthIdx: i + 1, monthTotal: sorted.length })) };
    });
    groups.sort((a, b) => (zoneOrderRank[a.zone.id] ?? 1e9) - (zoneOrderRank[b.zone.id] ?? 1e9) || a.zone.name.localeCompare(b.zone.name));
    return groups;
  }, [monthTableRows, zoneOrderRank]);

  // 탭(전체/측정완료/예정)에 맞춰 각 구역의 회차만 걸러내고, 걸러진 회차가 하나도
  // 없는 구역은 목록에서 뺀다.
  const monTabZoneGroups = monthZoneGroups
    .map(g => ({
      zone: g.zone,
      occurrences: g.occurrences.filter(occ => {
        const isDone = completions.has(`${g.zone.id}_${occ.measurement.num}`);
        if (monTab === 'done') return isDone;
        if (monTab === 'pending') return !isDone;
        return true;
      }),
    }))
    .filter(g => g.occurrences.length > 0);

  const grid = buildGrid(year, month, weekStart);
  const dowOrder = weekStart === 'sun' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  const selectedCalibEvents = selectedDay ? (calibByDate[selectedDay] || []) : [];
  const selectedScheduleEvents = selectedDay ? (scheduleByDate[selectedDay] || []) : [];
  const selectedTempEvents = selectedDay ? (tempByDate[selectedDay] || []) : [];

  function dDayColor(dateStr) {
    try {
      const d = differenceInDays(parseISO(dateStr), today);
      if (d < 0) return 'bg-red-100 text-red-700 border border-red-200';
      if (d <= 7) return 'bg-orange-100 text-orange-700 border border-orange-200';
      return 'bg-yellow-50 text-yellow-700 border border-yellow-200';
    } catch { return 'bg-gray-100 text-gray-500'; }
  }

  function dDayText(dateStr) {
    try {
      const d = differenceInDays(parseISO(dateStr), today);
      if (d < 0) return `만료 ${Math.abs(d)}일`;
      if (d === 0) return 'D-Day';
      return `D-${d}`;
    } catch { return ''; }
  }

  function pushToast(type, message, durationMs) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), durationMs);
  }

  // 오류 알림은 다른 알림에 가려지지 않도록 성공 알림보다 오래(더 눈에 띄게) 유지된다.
  function showError(message) {
    pushToast('error', message, 5000);
  }

  function showSuccess(message) {
    pushToast('success', message, 3000);
  }

  // 측정완료 표시처럼 "일정 저장하기"를 거치지 않는 즉시 변경을 조용히(알림 없이)
  // 다른 PC와 공유한다. 공유 설정(Gist ID + 토큰)이 없으면 아무 것도 하지 않는다.
  async function silentSyncUpload() {
    try {
      const cfg = await syncGetConfig();
      if (cfg?.gistId && cfg?.hasToken) await syncUpload();
    } catch { /* 조용히 무시 — 사이드바 "지금 동기화"에서 재시도 가능 */ }
  }

  function getChipStyle(category, grade) {
    // 소분류는 소속 대분류의 색상을 따른다
    const major = getMajorCat(category, scheduleConfig);
    const cat = chipColors[`cat_${major}`] ?? DEFAULT_CHIP_COLORS[`cat_${major}`] ?? { bg: '#f3f4f6', border: '#e5e7eb' };
    const grd = chipColors[`grade_${grade}`] ?? DEFAULT_CHIP_COLORS[`grade_${grade}`] ?? { text: '#4b5563' };
    return { backgroundColor: cat.bg, borderColor: cat.border, borderWidth: '1px', borderStyle: 'solid', color: grd.text };
  }

  function updateChipColor(key, field, value) {
    setChipColors(prev => {
      const next = { ...prev, [key]: { ...(prev[key] ?? DEFAULT_CHIP_COLORS[key] ?? {}), [field]: value } };
      try { localStorage.setItem('em-chip-colors', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function handleOptimize() {
    const caps = {
      surface:  parseInt(optimizeCapacities.surface)  || 0,
      float:    parseInt(optimizeCapacities.float)    || 0,
      fall:     parseInt(optimizeCapacities.fall)     || 0,
      particle: parseInt(optimizeCapacities.particle) || 0,
      combined: parseInt(optimizeCapacities.combined) || 0,
    };
    try { localStorage.setItem('em-daily-capacities', JSON.stringify(optimizeCapacities)); } catch {}
    setOptimizing(true);
    try {
      const overrides = optimizeMonthSchedule({
        zones, tempSchedules, completions, year, month, capacities: caps, holidayMap: scheduleAvoid, namedGroups: groups,
      });
      const zoneIds = Object.keys(overrides);
      if (!zoneIds.length) {
        showSuccess('재배치가 필요한 일정이 없습니다.');
        setOptimizePopup(false);
        return;
      }
      let movedCount = 0;
      const updates = [];
      const moveLogs = [];
      for (const zid of zoneIds) {
        const zone = zones.find(z => String(z.id) === String(zid));
        if (!zone) continue;
        Object.entries(overrides[zid]).forEach(([num, toDate]) => {
          const fromDate = currentDateOf(zid, Number(num));
          moveLogs.push(`${zone.name}[${zone.grade}] ${num}회차: ${fromDate || '?'} → ${toDate}`);
        });
        movedCount += Object.keys(overrides[zid]).length;
        const u = { ...zone, schedule_overrides: { ...(zone.schedule_overrides || {}), ...overrides[zid] } };
        updates.push(u);
      }
      setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
      moveLogs.forEach(msg => logChange(msg));
      showSuccess(`${year}년 ${month}월 일정 ${movedCount}건을 재배치했습니다. "일정 저장하기"를 눌러야 반영됩니다.`);
      setOptimizePopup(false);
    } finally {
      setOptimizing(false);
    }
  }

  async function handlePhaseTransition(zoneId, newGrade, newStartDate) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone || !newStartDate) return;
    // Find existing zone with same name+category+targetGrade
    const existing = zones.find(z =>
      z.name === zone.name && z.category === zone.category && z.grade === newGrade && z.id !== zoneId
    );
    if (existing) {
      // Update start date only
      const updated = { ...existing, schedule_start: newStartDate };
      const saved = await upsertZone(updated);
      setZones(prev => prev.map(z => z.id === saved.id ? saved : z));
    } else {
      // Create new zone row for the target grade
      const newZone = {
        name: zone.name,
        category: zone.category,
        grade: newGrade,
        schedule_start: newStartDate,
        schedule_overrides: {},
        monthly_weekday_rule: null,
      };
      const saved = await upsertZone(newZone);
      setZones(prev => [...prev, saved]);
    }
    setPhasePrompt(null);
  }

  async function handleSetWeekdayRule(zoneId, rule) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, monthly_weekday_rule: rule };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  async function handleSaveGroup(group) {
    const saved = await upsertGroup(group);
    setGroups(prev => {
      const idx = prev.findIndex(g => g.id === saved.id);
      return idx >= 0 ? prev.map(g => g.id === saved.id ? saved : g) : [...prev, saved];
    });
    setNewGroupName('');
  }

  async function handleDeleteGroup(id) {
    await deleteGroup(id);
    setGroups(prev => prev.filter(g => g.id !== id));
  }

  async function handleSetZonePoint(zoneId, field, value) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, [field]: value };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  async function handleDropOnDay(dateStr, dragData) {
    if (!requireAdmin()) return;
    const zone = zones.find(z => z.id === dragData.zoneId);
    if (!zone) return;

    // 같은 날짜에 다시 내려놓은 경우는 실제 변경이 아니므로 조용히 무시 (저장/알람 없음)
    if (dragData.fromDateStr && dragData.fromDateStr === dateStr) return;

    if (blockedDates.has(dateStr)) {
      showError('일정비우기가 체크되어있습니다');
      return;
    }

    // 각 단계의 '첫 측정'을 옮기면 시작일 자체를 재설정 → 이후 일정 전부가
    // 새 시작일 기준 주기로 재배치된다. (기존 수동 이동은 초기화)
    // 일정관리의 시작일·종료예정일도 자동으로 갱신됨.
    // 첫 측정 번호에 override를 함께 남겨, P2/P3/유지관리처럼 주말이 기본적으로
    // 회피되는 등급도 요청한 날짜(주말 포함)에 그대로 고정되도록 한다.
    // (override가 없으면 자동 배치 로직이 평일로 다시 보정해버려 주말 지정이 무시됨)
    if (dragData.isFirst) {
      const updated = { ...zone, schedule_start: dateStr, schedule_overrides: { [String(dragData.num)]: dateStr } };
      setZones(prev => prev.map(z => z.id === zone.id ? updated : z));
      logMoveChange(`start:${zone.id}`, `시작일 변경: ${zone.name}[${zone.grade}]`, zone.schedule_start || '?', dateStr, ' (이후 일정 재배치)');
      showSuccess('시작일을 옮기고 이후 일정을 재배치했습니다. "일정 저장하기"를 눌러야 반영됩니다.');
      return;
    }

    if (dateStr < dragData.minDateStr || dateStr > dragData.maxDateStr) {
      const sm = dragData.spanMonths;
      const typeMsg = (dragData.type === 'weekly' || dragData.type === 'biweekly') ? '해당 주간 내'
        : dragData.type === 'monthly'
          ? (sm === 3 ? '해당 분기 내' : sm === 6 ? '해당 반기 내' : sm === 12 ? '해당 연도 내' : sm > 1 ? '해당 기간 내' : '해당 월 내')
          : '동일 날짜';
      showError(`측정주기 오류: ${typeMsg}에서만 일정을 옮길 수 있습니다. (${dragData.minDateStr} ~ ${dragData.maxDateStr})`);
      return;
    }

    // 같은 구역의 현재 측정일(회차→날짜) 맵
    const zoneMeas = {};
    Object.entries(scheduleByDate).forEach(([ds, arr]) => {
      arr.forEach(ev => { if (String(ev.zone.id) === String(zone.id)) zoneMeas[ev.measurement.num] = ds; });
    });
    // 이전 회차보다 앞선(또는 같은) 날짜로는 이동 불가 — 뒤로 밀 수는 있어도 앞 회차를 추월할 순 없다
    const prevDs = zoneMeas[dragData.num - 1];
    if (prevDs && dateStr <= prevDs) { showError('이전 회차보다 앞선 날짜로는 옮길 수 없습니다 (측정 순서 유지).'); return; }

    // 이동 대상이 그룹(폴더)에 속하고, 같은 날 같은 그룹의 다른 일정이 함께 있으면
    // 그룹 전체를 옮길지 물어본다.
    const grp = groups.find(g => (g.zoneIds || []).some(id => String(id) === String(zone.id)));
    if (grp && dragData.fromDateStr && dragData.fromDateStr !== dateStr) {
      const siblings = (scheduleByDate[dragData.fromDateStr] || []).filter(ev =>
        String(ev.zone.id) !== String(zone.id)
        && (grp.zoneIds || []).some(id => String(id) === String(ev.zone.id))
        && !completions.has(`${ev.zone.id}_${ev.measurement.num}`)
      );
      if (siblings.length > 0) {
        setGroupMovePrompt({
          dateStr,
          dragData,
          groupName: grp.name,
          members: siblings.map(ev => {
            const b = getDragBounds(ev.measurement, scheduleAvoid);
            return {
              zoneId: ev.zone.id, num: ev.measurement.num,
              min: format(b.min, 'yyyy-MM-dd'), max: format(b.max, 'yyyy-MM-dd'),
              label: `${ev.zone.name}[${ev.zone.grade}]-${ev.measurement.num}`,
            };
          }),
        });
        return;
      }
    }

    logMoveChange(`move:${zone.id}:${dragData.num}`, `${zone.name}[${zone.grade}] ${dragData.num}회차`, dragData.fromDateStr || '?', dateStr);
    moveMeasurementWithReflow(zone, dragData.num, dateStr);
    showSuccess(`${zone.name}[${zone.grade}] ${dragData.num}회차를 ${dateStr}로 옮겼습니다. "일정 저장하기"를 눌러야 반영됩니다.`);
  }

  // 단일 측정 이동 — 해당 회차를 옮기고, 이후 회차의 수동이동은 초기화해
  // 자동으로 뒤로 밀리게(순서 유지 재계산) 한다. (시작일 옮길 때와 유사)
  // 저장하기 전까지는 로컬 상태만 바뀐다.
  function moveMeasurementWithReflow(zone, num, dateStr) {
    const ov = { ...(zone.schedule_overrides || {}) };
    ov[String(num)] = dateStr;
    Object.keys(ov).forEach(k => { if (Number(k) > num) delete ov[k]; });
    const updated = { ...zone, schedule_overrides: ov };
    setZones(prev => prev.map(z => z.id === zone.id ? updated : z));
  }

  // 여러 측정을 새 날짜로 이동 — 구역별로 override를 합쳐 로컬 상태에 반영(초안).
  // moves: [{ zoneId, num, date }]
  function applyMoves(moves) {
    const byZone = {};
    moves.forEach(mv => { (byZone[mv.zoneId] || (byZone[mv.zoneId] = [])).push(mv); });
    const updates = [];
    Object.entries(byZone).forEach(([zid, mvs]) => {
      const zone = zones.find(z => String(z.id) === String(zid));
      if (!zone) return;
      const ov = { ...(zone.schedule_overrides || {}) };
      mvs.forEach(mv => { ov[String(mv.num)] = mv.date; });
      updates.push({ ...zone, schedule_overrides: ov });
    });
    if (!updates.length) return;
    // 실제로 setZones를 반영하기 전에 이동 전 날짜를 먼저 조회해둔다 (currentDateOf는 이전 zones 기준).
    const fromDates = moves.map(mv => currentDateOf(mv.zoneId, mv.num));
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
    moves.forEach((mv, i) => {
      const zone = zones.find(z => String(z.id) === String(mv.zoneId));
      if (zone) logMoveChange(`move:${zone.id}:${mv.num}`, `${zone.name}[${zone.grade}] ${mv.num}회차`, fromDates[i] || '?', mv.date);
    });
  }

  // 그룹 이동 프롬프트 확정 — includeMembers=true면 그룹 구성원까지 함께 이동.
  function confirmGroupMove(includeMembers) {
    const p = groupMovePrompt;
    if (!p) return;
    const moves = [{ zoneId: p.dragData.zoneId, num: p.dragData.num, date: p.dateStr }];
    let skipped = 0;
    if (includeMembers) {
      p.members.forEach(m => {
        if (p.dateStr < m.min || p.dateStr > m.max) { skipped++; return; } // 이동 범위 밖 → 제외
        moves.push({ zoneId: m.zoneId, num: m.num, date: p.dateStr });
      });
    }
    setGroupMovePrompt(null);
    applyMoves(moves);
    const moved = moves.length;
    showSuccess((includeMembers
      ? (skipped > 0 ? `${moved}건 이동 (이동 범위를 벗어난 ${skipped}건은 제외)` : `그룹 일정 ${moved}건을 함께 이동했습니다.`)
      : `${moved}건 이동했습니다.`) + ' "일정 저장하기"를 눌러야 반영됩니다.');
  }

  // 일정비우기 토글: 체크 시 해당일 일정을 모두 다른 날로 옮기고 그 날짜를 차단 (초안)
  function handleToggleBlockDay(dateStr, checked) {
    if (!requireAdmin()) return;
    setBlockedDates(prev => {
      const n = new Set(prev);
      if (checked) n.add(dateStr); else n.delete(dateStr);
      return n;
    });
    if (checked) {
      // 해당일에 override로 고정된 측정을 해제 → scheduleAvoid에 의해 자동으로 다른 날로 재배치
      const updates = [];
      const unpinnedLogs = [];
      zones.forEach(zone => {
        const ov = zone.schedule_overrides;
        if (!ov) return;
        const pinned = Object.entries(ov).filter(([, v]) => v === dateStr);
        if (!pinned.length) return;
        const nextOv = { ...ov };
        pinned.forEach(([k]) => {
          delete nextOv[k];
          unpinnedLogs.push(`${zone.name}[${zone.grade}] ${k}회차: ${dateStr} → 자동 재배치`);
        });
        updates.push({ ...zone, schedule_overrides: nextOv });
      });
      if (updates.length) {
        setZones(prev => prev.map(z => {
          const u = updates.find(x => x.id === z.id);
          return u || z;
        }));
      }
      unpinnedLogs.forEach(msg => logChange(msg));
    }
    logChange(`${dateStr} 일정비우기 ${checked ? '설정' : '해제'}`);
    showSuccess(`일정비우기를 ${checked ? '설정' : '해제'}했습니다. "일정 저장하기"를 눌러야 반영됩니다.`);
  }

  // 임시일정 이름 수정 (초안 — 저장하기 전까지는 로컬 상태만 변경)
  function renameTempSchedule(t, newName) {
    const name = newName.trim();
    setEditingTempId(null);
    if (!name || name === t.name) return;
    if (!requireAdmin()) return;
    setTempSchedules(prev => prev.map(x => x.id === t.id ? { ...x, name } : x));
    logChange(`임시일정 이름 변경: ${t.name} → ${name}`);
    showSuccess('임시 일정 이름을 변경했습니다. "일정 저장하기"를 눌러야 반영됩니다.');
  }

  // 임시일정 완료 처리 토글 (초안 — 저장하기 전까지는 로컬 상태만 변경, 나머지 임시일정
  // 수정과 동일한 방식)
  function toggleTempDone(t) {
    if (!requireAdmin()) return;
    const done = !t.done;
    setTempSchedules(prev => prev.map(x => x.id === t.id ? { ...x, done } : x));
    logChange(`임시일정 ${done ? '완료 처리' : '완료 취소'}: ${t.name} (${t.date})`);
    showSuccess(`임시 일정을 ${done ? '완료 처리' : '완료 취소'}했습니다. "일정 저장하기"를 눌러야 반영됩니다.`);
  }

  // 임시일정 삭제 확인 후 실행
  function confirmDeleteTemp() {
    const t = deleteTempPrompt;
    setDeleteTempPrompt(null);
    if (!t) return;
    // 이미 저장된 임시일정이면 삭제를 "저장하기" 때까지 예약, 초안(_draftNew)이면 바로 제거
    if (!t._draftNew) pendingTempDeletesRef.current = [...pendingTempDeletesRef.current, t.id];
    setTempSchedules(prev => prev.filter(x => x.id !== t.id));
    logChange(`임시일정 삭제: ${t.name} (${t.date})`);
    showSuccess('임시 일정을 삭제 예약했습니다. "일정 저장하기"를 눌러야 반영됩니다.');
  }

  // 되돌리기 — 마지막 저장 시점 상태로 전체 복원 (측정일 이동/시작일 변경/일정비우기/임시일정/최적화 초안 전체 취소)
  function handleRevertDraft() {
    if (!requireAdmin()) return;
    const snap = savedSnapshotRef.current;
    if (!snap) return;
    setZones(snap.zones);
    setBlockedDates(new Set(snap.blockedDates));
    setTempSchedules(snap.tempSchedules);
    pendingTempDeletesRef.current = [];
    setChangeLog([]);
    showSuccess('마지막 저장 상태로 되돌렸습니다.');
  }

  // 일정 저장하기 — 초안(zones/blockedDates/tempSchedules)을 실제로 저장하고,
  // 저장된 변경 내역을 요약 팝업으로 보여준다.
  async function handleSaveSchedule() {
    if (!requireAdmin()) return;
    const snap = savedSnapshotRef.current;
    if (!snap || changeLog.length === 0) { showSuccess('저장할 변경 사항이 없습니다.'); return; }
    setSavingSchedule(true);
    try {
      const snapZonesById = new Map(snap.zones.map(z => [z.id, z]));
      const changedZones = zones.filter(z => snapZonesById.get(z.id) !== z);
      await Promise.all(changedZones.map(z => upsertZone(z)));

      const addedBlocked = [...blockedDates].filter(d => !snap.blockedDates.has(d));
      const removedBlocked = [...snap.blockedDates].filter(d => !blockedDates.has(d));
      await Promise.all([
        ...addedBlocked.map(d => setBlockedDate(d, true)),
        ...removedBlocked.map(d => setBlockedDate(d, false)),
      ]);

      const drafts = tempSchedules.filter(t => t._draftNew);
      const savedDrafts = await Promise.all(drafts.map(t => {
        const { _draftNew, id, ...rest } = t;
        return addTempSchedule(rest);
      }));
      const toDelete = pendingTempDeletesRef.current;
      await Promise.all(toDelete.map(id => deleteTempSchedule(id)));

      // 이미 저장된 임시일정 중 이름 등이 수정된 것만 업데이트 (초안 스냅샷과 참조가 달라진 것)
      const snapTempById = new Map(snap.tempSchedules.map(t => [t.id, t]));
      const changedTemp = tempSchedules.filter(t => !t._draftNew && snapTempById.get(t.id) && snapTempById.get(t.id) !== t);
      await Promise.all(changedTemp.map(t => updateTempSchedule(t)));

      const finalTemp = tempSchedules.map(t => {
        if (!t._draftNew) return t;
        const idx = drafts.indexOf(t);
        return savedDrafts[idx] || t;
      });
      setTempSchedules(finalTemp);
      pendingTempDeletesRef.current = [];

      savedSnapshotRef.current = { zones, blockedDates: new Set(blockedDates), tempSchedules: finalTemp };
      window.electronAPI?.notifyDataChanged?.();
      const msgs = changeLog.map(c => c.msg);
      setChangeSummary(msgs);
      recordChangeHistory(msgs);
      setChangeLog([]);

      // 저장한 일정을 다른 PC와 공유하기 위해 공유 동기화(Gist)에 자동 업로드한다.
      // 공유 설정(Gist ID + 토큰)이 없으면 조용히 건너뛴다.
      try {
        const cfg = await syncGetConfig();
        if (cfg?.gistId && cfg?.hasToken) {
          const r = await syncUpload();
          setSaveSyncNote(r?.ok
            ? '🔄 다른 PC와 공유 완료'
            : `⚠ 공유 업로드 실패: ${r?.error || ''} (사이드바 "지금 동기화"에서 다시 시도하세요)`);
        } else {
          setSaveSyncNote(null);
        }
      } catch {
        setSaveSyncNote('⚠ 공유 업로드 중 오류가 발생했습니다. 사이드바 "지금 동기화"에서 다시 시도하세요.');
      }
    } catch (e) {
      showError('저장 실패: ' + e.message);
    } finally {
      setSavingSchedule(false);
    }
  }

  const selDow = selectedDay ? new Date(selectedDay + 'T00:00:00').getDay() : 0;
  const isSelHol = selectedDay ? !!holidays[selectedDay] : false;
  const hdBg = (selDow === 0 || isSelHol) ? 'bg-red-500' : selDow === 6 ? 'bg-blue-600' : 'bg-gray-600';
  const hdSub = (selDow === 0 || isSelHol) ? 'text-red-200' : selDow === 6 ? 'text-blue-200' : 'text-gray-300';

  return (
    <div className="p-6 space-y-5">

      {/* 오류/성공 알림 스택 — 서로 겹쳐서 가려지지 않도록 세로로 쌓아 각각 독립적으로 표시 */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 ${t.type === 'error' ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}
            >
              <span className="text-base shrink-0 mt-0.5">{t.type === 'error' ? '⚠' : '✓'}</span>
              <span className="text-sm font-medium flex-1 leading-snug">{t.message}</span>
              <button
                onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                className={`text-lg leading-none shrink-0 ${t.type === 'error' ? 'text-red-200 hover:text-white' : 'text-green-200 hover:text-white'}`}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* 일정 저장 완료 후 변동 내역 알람 */}
      {changeSummary && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40" onClick={() => { setChangeSummary(null); setSaveSyncNote(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[92vw] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <span className="text-lg">🔔</span>
              <h3 className="text-base font-bold text-gray-900">일정이 저장되었습니다</h3>
            </div>
            <div className="px-5 py-3 overflow-y-auto flex-1">
              <p className="text-xs text-gray-400 mb-2">변경 내역 {changeSummary.length}건</p>
              <ul className="space-y-1.5">
                {changeSummary.map((msg, i) => (
                  <li key={i} className="text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">{msg}</li>
                ))}
              </ul>
              {saveSyncNote && (
                <p className={`text-xs mt-3 ${saveSyncNote.startsWith('⚠') ? 'text-red-500' : 'text-emerald-600'}`}>{saveSyncNote}</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100">
              <button onClick={() => { setChangeSummary(null); setSaveSyncNote(null); }}
                className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">확인</button>
            </div>
          </div>
        </div>
      )}

      {/* 일정변경 알람 내역 (이 PC에 저장된 지난 저장 이력) */}
      {showChangeHistory && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40" onClick={() => setShowChangeHistory(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[460px] max-w-[92vw] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <span className="text-lg">🔔</span>
              <h3 className="text-base font-bold text-gray-900">일정변경 알람 내역</h3>
              <span className="text-xs text-gray-400">(이 PC · 최근 {CHANGE_HISTORY_MAX}건)</span>
            </div>
            <div className="px-5 py-3 overflow-y-auto flex-1">
              {changeHistory.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">저장된 일정변경 내역이 없습니다.</p>
              ) : (
                <ul className="space-y-3">
                  {changeHistory.map((h, i) => (
                    <li key={i} className="border border-gray-100 rounded-lg overflow-hidden">
                      <div className="px-3 py-1.5 bg-gray-50 text-xs font-semibold text-gray-600 flex items-center gap-1.5">
                        <span>{new Date(h.ts).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        {h.source === 'sync' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600 font-medium">동기화 수신</span>
                        )}
                        <span className="text-gray-400 font-normal ml-auto">{h.changes.length}건</span>
                      </div>
                      <ul className="divide-y divide-gray-50">
                        {h.changes.map((msg, j) => (
                          <li key={j} className="px-3 py-1.5 text-sm text-gray-700">{msg}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex gap-2">
              {changeHistory.length > 0 && (
                <button
                  onClick={() => {
                    setChangeHistory([]);
                    try { localStorage.removeItem(CHANGE_HISTORY_KEY); } catch { /* ignore */ }
                  }}
                  className="px-4 py-2 border border-gray-300 text-gray-500 rounded-lg text-sm hover:bg-gray-50"
                >내역 지우기</button>
              )}
              <button onClick={() => setShowChangeHistory(false)}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* Phase transition modal */}
      {phasePrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6">
            <h3 className="text-base font-bold text-gray-900 mb-1">
              {phasePrompt.label || `${phasePrompt.nextGrade} 단계 추가`}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              <span className="font-semibold text-gray-700">{phasePrompt.zoneName}</span> 구역에{' '}
              <span className={`font-bold px-1.5 py-0.5 rounded text-xs ${GRADE_COLORS[phasePrompt.nextGrade] || 'bg-gray-100 text-gray-600'}`}>
                {phasePrompt.nextGrade}
              </span>{' '}
              행을 추가합니다. 이미 있으면 시작일만 업데이트됩니다.
            </p>
            <label className="block text-xs text-gray-500 mb-1">{phasePrompt.nextGrade} 시작일</label>
            <input
              type="date"
              value={phasePrompt.dateStr}
              onChange={e => setPhasePrompt(prev => ({ ...prev, dateStr: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPhasePrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
              >취소</button>
              <button
                onClick={() => handlePhaseTransition(phasePrompt.zoneId, phasePrompt.nextGrade, phasePrompt.dateStr)}
                disabled={!phasePrompt.dateStr}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40"
              >{phasePrompt.nextGrade} 추가/업데이트</button>
            </div>
          </div>
        </div>
      )}

      {/* Completion confirm modal */}
      {completionPrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => setCompletionPrompt(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">
              {completionPrompt.isCompleted ? '완료 취소' : '측정 완료 처리'}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              <span className="font-semibold text-gray-800">{completionPrompt.zoneName}[{completionPrompt.grade}]</span><br/>
              {completionPrompt.num}번째 측정을{' '}
              {completionPrompt.isCompleted ? '완료 취소 하시겠습니까?' : '완료 처리 하시겠습니까?'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setCompletionPrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">취소</button>
              <button
                onClick={async () => {
                  const { zoneId, num, isCompleted } = completionPrompt;
                  const key = `${zoneId}_${num}`;
                  if (isCompleted) {
                    await deleteCompletion(zoneId, num);
                    setCompletions(prev => { const n = new Set(prev); n.delete(key); return n; });
                  } else {
                    await setCompletion(zoneId, num);
                    setCompletions(prev => new Set([...prev, key]));
                  }
                  setCompletionPrompt(null);
                  // 측정완료는 "일정 저장하기"를 거치지 않으므로 여기서 바로 공유 동기화한다.
                  // 알림 팝업 없이 조용히 백그라운드로 업로드만 한다.
                  silentSyncUpload();
                }}
                className={`px-4 py-2 text-sm text-white rounded-lg ${completionPrompt.isCompleted ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}`}
              >{completionPrompt.isCompleted ? '완료 취소' : '완료 처리'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 임시일정 삭제 확인 */}
      {deleteTempPrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => setDeleteTempPrompt(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">임시 일정 삭제</h3>
            <p className="text-sm text-gray-500 mb-4">
              <span className="font-semibold text-gray-800">{deleteTempPrompt.name}</span>을(를) 삭제하시겠습니까?
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTempPrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">취소</button>
              <button onClick={confirmDeleteTemp}
                className="px-4 py-2 text-sm text-white rounded-lg bg-red-500 hover:bg-red-600">삭제</button>
            </div>
          </div>
        </div>
      )}

      {/* 그룹 일정 함께 이동 확인 */}
      {groupMovePrompt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => setGroupMovePrompt(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-96 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">그룹 일정 함께 이동</h3>
            <p className="text-sm text-gray-500 mb-3">
              이 일정은 <span className="font-semibold text-blue-600">{groupMovePrompt.groupName}</span> 그룹에 속합니다.<br/>
              같은 날의 그룹 일정 <span className="font-semibold text-gray-800">{groupMovePrompt.members.length}건</span>을 <span className="font-semibold text-gray-800">{groupMovePrompt.dateStr}</span>(으)로 함께 옮길까요?
            </p>
            <div className="max-h-32 overflow-y-auto mb-4 rounded-lg bg-gray-50 border border-gray-100 divide-y divide-gray-100">
              {groupMovePrompt.members.map(m => (
                <div key={`${m.zoneId}_${m.num}`} className="px-3 py-1.5 text-xs text-gray-600 flex items-center justify-between">
                  <span className="truncate">{m.label}</span>
                  {(groupMovePrompt.dateStr < m.min || groupMovePrompt.dateStr > m.max)
                    && <span className="shrink-0 ml-2 text-[10px] text-amber-500">범위 밖·제외</span>}
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => confirmGroupMove(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">이 일정만 이동</button>
              <button onClick={() => confirmGroupMove(true)}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700">그룹 전체 이동</button>
            </div>
          </div>
        </div>
      )}

      {/* Add temp schedule popup */}
      {addSchedPopup && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => setAddSchedPopup(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">임시 일정 추가</h3>
            <p className="text-sm text-gray-400 mb-4">{addSchedPopup.date}</p>
            <label className="block text-xs text-gray-500 mb-1">이름</label>
            <input
              type="text"
              value={addSchedName}
              onChange={e => setAddSchedName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && addSchedName.trim()) document.getElementById('add-sched-submit')?.click(); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 mb-4"
              placeholder="일정 이름 입력..."
              autoFocus
            />
            <label className="block text-xs text-gray-500 mb-2">측정 포인트 수</label>
            <div className="grid grid-cols-4 gap-2 mb-5">
              {[['surface','표면균'],['float','부유균'],['fall','낙하균'],['particle','부유입자']].map(([key, label]) => (
                <div key={key} className="flex flex-col items-center gap-1">
                  <span className="text-[10px] text-gray-400">{label}</span>
                  <input
                    type="number"
                    min="0"
                    max="999"
                    value={addSchedPts[key]}
                    onChange={e => setAddSchedPts(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-orange-400"
                    placeholder="0"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setAddSchedPopup(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">취소</button>
              <button
                id="add-sched-submit"
                disabled={!addSchedName.trim()}
                onClick={() => {
                  if (!addSchedName.trim()) return;
                  // 저장하기 전까지는 로컬 임시 id로만 보관 (_draftNew), 저장 시 실제로 생성된다.
                  const entry = {
                    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    date: addSchedPopup.date,
                    name: addSchedName.trim(),
                    points_surface: parseInt(addSchedPts.surface) || 0,
                    points_float: parseInt(addSchedPts.float) || 0,
                    points_fall: parseInt(addSchedPts.fall) || 0,
                    points_particle: parseInt(addSchedPts.particle) || 0,
                    _draftNew: true,
                  };
                  setTempSchedules(prev => [...prev, entry]);
                  logChange(`임시일정 추가: ${entry.name} (${entry.date})`);
                  showSuccess('임시 일정을 추가했습니다. "일정 저장하기"를 눌러야 반영됩니다.');
                  setAddSchedPopup(null);
                  setAddSchedName('');
                  setAddSchedPts({ surface: '', float: '', fall: '', particle: '' });
                }}
                className="px-4 py-2 text-sm text-white bg-orange-500 rounded-lg hover:bg-orange-600 disabled:opacity-40"
              >추가</button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule optimize popup */}
      {optimizePopup && (() => {
        const prefix = `${year}-${String(month).padStart(2, '0')}-`;
        const sp = z => ({ s: z.points_surface||0, f: z.points_float||0, l: z.points_fall||0, p: z.points_particle||0 });
        // Per-(cat,date) type sums
        const catDateType = {}; // cat -> date -> {s,f,l,p}
        Object.entries(scheduleByDate).forEach(([ds, arr]) => {
          if (!ds.startsWith(prefix)) return;
          arr.forEach(({ zone }) => {
            const pts = sp(zone);
            if (!catDateType[zone.category]) catDateType[zone.category] = {};
            const cur = catDateType[zone.category][ds] || (catDateType[zone.category][ds] = {s:0,f:0,l:0,p:0});
            cur.s+=pts.s; cur.f+=pts.f; cur.l+=pts.l; cur.p+=pts.p;
          });
        });
        // 질소+압축공기 combined per date
        const combDay = {};
        Object.entries(scheduleByDate).forEach(([ds, arr]) => {
          if (!ds.startsWith(prefix)) return;
          arr.forEach(({ zone }) => {
            if (zone.category === '질소가스' || zone.category === '압축공기') {
              const p = sp(zone); combDay[ds] = (combDay[ds]||0)+p.s+p.f+p.l+p.p;
            }
          });
        });
        Object.entries(tempByDate).forEach(([ds, arr]) => {
          if (!ds.startsWith(prefix)) return;
          arr.forEach(t => { const p=sp(t); combDay[ds]=(combDay[ds]||0)+p.s+p.f+p.l+p.p; });
        });
        const caps = { s: parseInt(optimizeCapacities.surface)||0, f: parseInt(optimizeCapacities.float)||0, l: parseInt(optimizeCapacities.fall)||0, p: parseInt(optimizeCapacities.particle)||0, comb: parseInt(optimizeCapacities.combined)||0 };
        let violations = 0;
        Object.values(catDateType).forEach(dateMp => Object.values(dateMp).forEach(t => {
          if (caps.s>0&&t.s>caps.s) violations++;
          if (caps.f>0&&t.f>caps.f) violations++;
          if (caps.l>0&&t.l>caps.l) violations++;
          if (caps.p>0&&t.p>caps.p) violations++;
        }));
        if (caps.comb>0) Object.values(combDay).forEach(v => { if(v>caps.comb) violations++; });

        const CAP_FIELDS = [['surface','표면균','green'],['float','부유균','blue'],['fall','낙하균','orange'],['particle','부유입자(공조)','pink']];
        return (
          <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => !optimizing && setOptimizePopup(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-bold text-gray-900 mb-1">⚖ 일정 최적화</h3>
              <p className="text-xs text-gray-400 mb-4 leading-relaxed">
                {year}년 {MONTH_KR[month - 1]} 일정을 <b>①그룹 → ②측정주기(유형별 용량) → ③빈 날 채우기</b> 순서로 배정합니다.
                같은 그룹 측정을 먼저 같은 날로 모으고, 그 다음 하루 포인트가 설정값을 넘는 날을 측정주기 내
                여유일로 옮기며, 그래도 일정이 하나도 없는 날이 남으면 이동 가능한 측정을 채워 넣습니다.
                그룹·측정주기 배정이 항상 우선이므로, 그룹에 속한 구역의 측정은 빈 날 채우기로
                다시 흩어지지 않습니다.
                공조·질소가스·압축공기는 <b>각각 따로</b> 계산되며, 질소+압축공기는 합산도 확인합니다. (완료·임시 고정)
                주말·공휴일·일정비우기로 설정된 날은 제외합니다. (최대값을 비워둬도 ①③은 동작합니다)
              </p>

              <div className="space-y-2 mb-4">
                <p className="text-xs font-semibold text-gray-600 mb-1">공조 — 유형별 하루 최대 (0 = 제한없음)</p>
                <div className="grid grid-cols-2 gap-2">
                  {CAP_FIELDS.map(([key, label]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
                      <input type="number" min="0" max="9999"
                        value={optimizeCapacities[key]}
                        onChange={e => setOptimizeCapacities(prev => ({ ...prev, [key]: e.target.value }))}
                        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        placeholder="0"
                      />
                    </div>
                  ))}
                </div>
                <div className="border-t border-gray-100 pt-2 mt-1">
                  <p className="text-xs font-semibold text-gray-600 mb-1">질소가스 + 압축공기 합산 최대</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-24 shrink-0">합산 합계</span>
                    <input type="number" min="0" max="9999"
                      value={optimizeCapacities.combined}
                      onChange={e => setOptimizeCapacities(prev => ({ ...prev, combined: e.target.value }))}
                      className="w-24 border border-gray-200 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-purple-500"
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>

              <div className={`rounded-lg px-3 py-2 mb-4 ${violations > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                <p className={`text-sm font-bold ${violations > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  현재 위반 {violations}건
                  <span className="text-xs font-normal ml-2 text-gray-400">(현재 달력 기준, 설정값 적용 시)</span>
                </p>
              </div>

              <div className="flex gap-2 justify-end">
                <button onClick={() => setOptimizePopup(false)} disabled={optimizing}
                  className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-40">취소</button>
                <button onClick={handleOptimize} disabled={optimizing}
                  className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                  {optimizing ? '재배치 중...' : '최적화 실행'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Calendar settings popup */}
      {calSettingsPopup && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40" onClick={() => setCalSettingsPopup(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full mx-4 p-6 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">🗓 달력 설정</h3>
            <p className="text-xs text-gray-400 mb-4">달력의 시작 요일 및 공휴일을 관리합니다.</p>
            <label className="block text-xs font-semibold text-gray-600 mb-2">주 시작 요일</label>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {[['sun', '일요일 시작'], ['mon', '월요일 시작']].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => changeWeekStart(val)}
                  className={`py-2.5 text-sm font-medium rounded-lg border transition-colors ${
                    weekStart === val
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >{label}</button>
              ))}
            </div>

            {/* 공휴일 관리 */}
            <div className="border-t border-gray-100 pt-4 flex flex-col min-h-0">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">공휴일 관리</h4>
              {/* 추가 폼 */}
              <div className="space-y-2 shrink-0 mb-3">
                <div className="flex gap-2 items-start">
                  <input type="date" value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32 shrink-0" />
                  <input type="text" placeholder="공휴일 이름" value={newHolidayName} onChange={e => setNewHolidayName(e.target.value)}
                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <button
                    onClick={async () => {
                      if (!newHolidayDate || !newHolidayName.trim()) return;
                      // 음력은 매년 반복만 의미가 있으므로 yearly로 고정
                      const repeat = newHolidayLunar
                        ? (newHolidayRepeat ? { type: 'yearly' } : null)
                        : (newHolidayRepeat
                            ? (newHolidayRepeatType === 'nth-weekday'
                                ? { type: 'nth-weekday', nth: newHolidayNth, dow: newHolidayDow }
                                : { type: newHolidayRepeatType })
                            : null);
                      const h = { date: newHolidayLunar ? 'L' + newHolidayDate : newHolidayDate, name: newHolidayName.trim(), repeat, substitute: newHolidaySubstitute, lunar: newHolidayLunar, bridgeBefore: Math.max(0, parseInt(newHolidayBridgeBefore) || 0), bridgeAfter: Math.max(0, parseInt(newHolidayBridgeAfter) || 0) };
                      const saved = await upsertHoliday(h);
                      setHolidayDefs(prev => {
                        const idx = prev.findIndex(x => x.date === saved.date);
                        return idx >= 0 ? prev.map((x,i) => i === idx ? saved : x) : [...prev, saved];
                      });
                      setNewHolidayDate(''); setNewHolidayName(''); setNewHolidayRepeat(false); setNewHolidaySubstitute(false); setNewHolidayLunar(false); setNewHolidayBridgeBefore(0); setNewHolidayBridgeAfter(0);
                    }}
                    className="px-2.5 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 shrink-0"
                  >추가</button>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={newHolidayRepeat} onChange={e => setNewHolidayRepeat(e.target.checked)} className="rounded" />
                    반복
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={newHolidayLunar} onChange={e => setNewHolidayLunar(e.target.checked)} className="rounded" />
                    음력
                    <span className="text-[10px] text-gray-400">(설날·추석 등)</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={newHolidaySubstitute} onChange={e => setNewHolidaySubstitute(e.target.checked)} className="rounded" />
                    대체공휴일
                    <span className="text-[10px] text-gray-400">(주말이면 다음 평일 휴무)</span>
                  </label>
                </div>
                {/* 연휴 (기준일 앞/뒤 포함 일수) */}
                <div className="flex items-center gap-2 flex-wrap text-xs text-gray-600">
                  <span className="text-gray-500">연휴</span>
                  <label className="flex items-center gap-1">앞
                    <input type="number" min="0" max="10" value={newHolidayBridgeBefore}
                      onChange={e => setNewHolidayBridgeBefore(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-12 border border-gray-200 rounded px-1.5 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />일
                  </label>
                  <label className="flex items-center gap-1">뒤
                    <input type="number" min="0" max="10" value={newHolidayBridgeAfter}
                      onChange={e => setNewHolidayBridgeAfter(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-12 border border-gray-200 rounded px-1.5 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />일
                  </label>
                  <span className="text-[10px] text-gray-400">기준일 앞/뒤를 "이름 연휴"로 포함 (앞뒤 모두 가능)</span>
                </div>
                {newHolidayLunar && newHolidayDate && (() => {
                  const [, lmm, ldd] = newHolidayDate.split('-').map(Number);
                  const sol = lunarToSolar(year, lmm, ldd);
                  return (
                    <div className="text-[10px] text-amber-600 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                      음력 {lmm}월 {ldd}일 → {year}년 양력 {sol ? `${sol.getMonth() + 1}월 ${sol.getDate()}일` : '변환 불가'}
                      {newHolidayRepeat ? ' (매년 음력 반복)' : ''}
                    </div>
                  );
                })()}
                {newHolidayRepeat && !newHolidayLunar && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <select value={newHolidayRepeatType} onChange={e => setNewHolidayRepeatType(e.target.value)}
                      className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="yearly">매년</option>
                      <option value="monthly">매월</option>
                      <option value="nth-weekday">N번째 요일</option>
                    </select>
                    {newHolidayRepeatType === 'nth-weekday' && (
                      <>
                        <select value={newHolidayNth} onChange={e => setNewHolidayNth(Number(e.target.value))}
                          className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                          <option value={1}>1번째</option>
                          <option value={2}>2번째</option>
                          <option value={3}>3번째</option>
                          <option value={4}>4번째</option>
                          <option value={5}>마지막</option>
                        </select>
                        <select value={newHolidayDow} onChange={e => setNewHolidayDow(Number(e.target.value))}
                          className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                          {['일','월','화','수','목','금','토'].map((d,i) => <option key={i} value={i}>{d}요일</option>)}
                        </select>
                      </>
                    )}
                    {newHolidayRepeatType === 'yearly' && newHolidayDate && (
                      <span className="text-[10px] text-gray-400">매년 {newHolidayDate.slice(5)} 반복</span>
                    )}
                    {newHolidayRepeatType === 'monthly' && newHolidayDate && (
                      <span className="text-[10px] text-gray-400">매월 {Number(newHolidayDate.slice(8))}일 반복</span>
                    )}
                  </div>
                )}
              </div>
              {/* 공휴일 목록 */}
              <div className="flex-1 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg" style={{ maxHeight: 200 }}>
                {holidayDefs.length === 0 && (
                  <p className="px-4 py-4 text-sm text-gray-400">등록된 공휴일이 없습니다.</p>
                )}
                {[...holidayDefs].sort((a,b) => a.date.localeCompare(b.date)).map(h => {
                  const lraw = h.lunar ? h.date.replace(/^L/, '') : h.date;
                  const lm = h.lunar ? Number(lraw.slice(5,7)) : 0;
                  const ld = h.lunar ? Number(lraw.slice(8)) : 0;
                  const repeatLabel = !h.repeat || h.repeat.type === 'none' ? null
                    : h.lunar ? `매년 음력 ${lm}월 ${ld}일`
                    : h.repeat.type === 'yearly' ? `매년 ${h.date.slice(5)}`
                    : h.repeat.type === 'monthly' ? `매월 ${Number(h.date.slice(8))}일`
                    : `매월 ${['','1번째','2번째','3번째','4번째','마지막'][h.repeat.nth]}${ ['일','월','화','수','목','금','토'][h.repeat.dow]}요일`;
                  const lunarSol = h.lunar ? lunarToSolar(year, lm, ld, !!h.leapMonth) : null;
                  const dateLabel = h.lunar ? `음력 ${lm}.${ld}` : h.date;
                  return (
                    <div key={h.date} className="flex items-center gap-2 px-3 py-2">
                      <span className="text-xs text-gray-500 w-24 shrink-0">
                        {dateLabel}
                        {lunarSol && <span className="block text-[10px] text-amber-600">→{year} {lunarSol.getMonth() + 1}.{lunarSol.getDate()}</span>}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-red-600 font-medium">{h.name}</span>
                        {h.lunar && <span className="ml-1.5 text-[10px] text-amber-600 bg-amber-50 px-1 py-0.5 rounded">음력</span>}
                        {repeatLabel && <span className="ml-1.5 text-[10px] text-blue-500 bg-blue-50 px-1 py-0.5 rounded">{repeatLabel}</span>}
                        {(h.bridgeBefore > 0 || h.bridgeAfter > 0) && <span className="ml-1.5 text-[10px] text-orange-600 bg-orange-50 px-1 py-0.5 rounded">연휴 {h.bridgeBefore > 0 ? `앞${h.bridgeBefore}` : ''}{h.bridgeBefore > 0 && h.bridgeAfter > 0 ? '·' : ''}{h.bridgeAfter > 0 ? `뒤${h.bridgeAfter}` : ''}</span>}
                        {h.substitute && <span className="ml-1.5 text-[10px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded">대체공휴일</span>}
                      </div>
                      <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer select-none shrink-0" title="주말이면 다음 평일을 대체공휴일로 지정">
                        <input type="checkbox" checked={!!h.substitute} onChange={async e => {
                          const updated = { ...h, substitute: e.target.checked };
                          await upsertHoliday(updated);
                          setHolidayDefs(prev => prev.map(x => x.date === h.date ? updated : x));
                        }} className="rounded" />
                        대체
                      </label>
                      <button onClick={async () => {
                        await deleteHoliday(h.date);
                        setHolidayDefs(prev => prev.filter(x => x.date !== h.date));
                      }} className="text-xs text-gray-400 hover:text-red-500 shrink-0">✕</button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end mt-4 shrink-0">
              <button onClick={() => setCalSettingsPopup(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* Chip color picker popover */}
      {colorPicker && (
        <div
          ref={colorPickerRef}
          className="fixed z-[300] bg-white rounded-xl shadow-2xl border border-gray-200 p-4 w-52"
          style={{ left: colorPicker.x, top: colorPicker.y }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-800">{colorPicker.label} 색상</span>
            <button onClick={() => setColorPicker(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
          </div>

          {/* Preview */}
          <div className="flex justify-center mb-3 py-2 bg-gray-50 rounded-lg">
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={colorPicker.type === 'cat'
                ? { backgroundColor: chipColors[colorPicker.key]?.bg, borderColor: chipColors[colorPicker.key]?.border, borderWidth: 1, borderStyle: 'solid', color: '#374151' }
                : { color: chipColors[colorPicker.key]?.text, fontWeight: 700, fontSize: '0.8rem' }
              }
            >
              {colorPicker.type === 'cat' ? `${colorPicker.label}[P1]` : colorPicker.label}
            </span>
          </div>

          <div className="space-y-2.5">
            {colorPicker.type === 'cat' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">배경색</span>
                  <input type="color"
                    value={chipColors[colorPicker.key]?.bg ?? '#ffffff'}
                    onChange={e => updateChipColor(colorPicker.key, 'bg', e.target.value)}
                    className="w-9 h-7 rounded cursor-pointer p-0.5 border border-gray-200"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">테두리색</span>
                  <input type="color"
                    value={chipColors[colorPicker.key]?.border ?? '#e5e7eb'}
                    onChange={e => updateChipColor(colorPicker.key, 'border', e.target.value)}
                    className="w-9 h-7 rounded cursor-pointer p-0.5 border border-gray-200"
                  />
                </div>
              </>
            )}
            {colorPicker.type === 'grade' && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600">글씨색</span>
                <input type="color"
                  value={chipColors[colorPicker.key]?.text ?? '#374151'}
                  onChange={e => updateChipColor(colorPicker.key, 'text', e.target.value)}
                  className="w-9 h-7 rounded cursor-pointer p-0.5 border border-gray-200"
                />
              </div>
            )}
          </div>

          <button
            onClick={() => {
              const defaults = DEFAULT_CHIP_COLORS[colorPicker.key];
              setChipColors(prev => {
                const next = { ...prev, [colorPicker.key]: { ...defaults } };
                try { localStorage.setItem('em-chip-colors', JSON.stringify(next)); } catch {}
                return next;
              });
            }}
            className="w-full mt-3 text-xs text-gray-500 bg-gray-100 hover:bg-gray-200 rounded-lg py-1.5 transition-colors"
          >기본값으로 되돌리기</button>
        </div>
      )}

      {/* 순서/그룹 · 측정주기 관리 팝업 */}
      {showOrderManager && (
        <OrderGroupManager
          zones={zones}
          groups={groups}
          holidayDefs={holidayDefs}
          onClose={() => setShowOrderManager(false)}
          onSaved={(updatedZones, updatedGroups) => {
            // 일정 관리(OrderGroupManager)는 자체적으로 즉시 저장하므로, 여기서 바뀐
            // 구역은 초안 기준선(savedSnapshotRef)도 함께 갱신한다. 건드리지 않은 구역은
            // 기존 기준선을 유지해 "월별 모니터링 일정"의 미저장 초안이 사라지지 않게 한다.
            if (savedSnapshotRef.current) {
              const prevById = new Map(zones.map(z => [z.id, z]));
              const snapById = new Map(savedSnapshotRef.current.zones.map(z => [z.id, z]));
              const nextSnapZones = updatedZones.map(z => (prevById.get(z.id) !== z ? z : (snapById.get(z.id) || z)));
              savedSnapshotRef.current = { ...savedSnapshotRef.current, zones: nextSnapZones };
            }
            setZones(updatedZones);
            setGroups(updatedGroups);
          }}
        />
      )}


      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">월별 모니터링 일정</h1>
          {totalMonthSchedule > 0 && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
              이번달 {totalMonthSchedule}건 측정 예정
            </span>
          )}
          {changeLog.length > 0 && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full font-medium">
              미저장 변경 {changeLog.length}건
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {adminUnlocked && (
            <>
              <button
                onClick={handleRevertDraft}
                disabled={changeLog.length === 0}
                title="마지막 저장 상태로 되돌리기"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ↩ 되돌리기
              </button>
              <button
                onClick={handleSaveSchedule}
                disabled={changeLog.length === 0 || savingSchedule}
                title="변경된 일정을 저장"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {savingSchedule ? '저장 중…' : '💾 일정 저장하기'}
              </button>
            </>
          )}
          <button
            onClick={() => {
              // 다른 곳(동기화 알람 등)에서 기록된 내역까지 최신으로 보기 위해 다시 읽어온다.
              try { setChangeHistory(JSON.parse(localStorage.getItem(CHANGE_HISTORY_KEY)) || []); } catch { /* ignore */ }
              setShowChangeHistory(true);
            }}
            title="지난 일정변경 알람 내역 확인"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
          >
            🔔 알람 내역
          </button>
          <div className="flex rounded-xl border border-gray-200 overflow-hidden bg-white text-sm">
            <button onClick={() => setViewMode('calendar')} className={`px-3 py-1.5 font-medium ${viewMode === 'calendar' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>📅 달력</button>
            <button onClick={() => setViewMode('table')} className={`px-3 py-1.5 font-medium ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>☰ 표</button>
          </div>
          <button
            onClick={handlePrint}
            title="이번 달 일정을 가로 PDF로 열기 (뷰어에서 인쇄하면 항상 가로로 출력)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
          >
            🖨 인쇄(가로 PDF)
          </button>
          <button
            onClick={handleExportExcel}
            title="이번 달 일정을 엑셀 표 서식(표 스타일 보통 16)으로 저장"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
          >
            📊 엑셀로 내보내기
          </button>
          <button
            onClick={() => { if (requireAdmin()) setOptimizePopup(true); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border transition-colors ${adminUnlocked ? 'text-indigo-600 bg-indigo-50 border-indigo-200 hover:bg-indigo-100' : 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed'}`}
          >
            ⚖ 일정 최적화
          </button>
          <button
            onClick={openOrderManagerPopup}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border transition-colors ${adminUnlocked ? 'text-gray-600 bg-white border-gray-200 hover:bg-gray-50' : 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed'}`}
          >
            🗂 일정 관리
          </button>
          <button
            onClick={() => { if (requireAdmin()) setCalSettingsPopup(true); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl border transition-colors ${adminUnlocked ? 'text-gray-600 bg-white border-gray-200 hover:bg-gray-50' : 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed'}`}
          >
            🗓 달력 설정
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            monRate === 100 ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'
          }`}>{monRate}%</div>
          <div>
            <p className="text-xs text-gray-500">모니터링</p>
            <p className="text-sm font-semibold text-gray-700">{completedCount}/{zones.length} 구역</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            calibThisMonthCount > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'
          }`}>{calibThisMonthCount}</div>
          <div>
            <p className="text-xs text-gray-500">교정 예정일</p>
            <p className="text-sm font-semibold text-gray-700">이번달</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
            currentMonthAhuTasks.length > 0 ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-400'
          }`}>{currentMonthAhuTasks.filter(t => t.done).length}/{currentMonthAhuTasks.length}</div>
          <div>
            <p className="text-xs text-gray-500">AHU 계획</p>
            <p className="text-sm font-semibold text-gray-700">완료/예정</p>
          </div>
        </div>
      </div>

      <div className="flex gap-5">
        {/* Calendar */}
        <div ref={printAreaRef} className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0 print-area">
          {/* 년/월 표시 + 이전/다음 (달력 테두리 안, 인쇄 시에도 표시) */}
          <div className="cal-monthbar flex items-center justify-center gap-4 px-4 py-3 border-b border-gray-100">
            <button onClick={prevMonth} className="print:hidden p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-xl leading-none">‹</button>
            <span className="text-2xl font-bold text-gray-900 min-w-[160px] text-center">{year}년 {MONTH_KR[month - 1]}</span>
            <button onClick={nextMonth} className="print:hidden p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-xl leading-none">›</button>
          </div>
          {viewMode === 'table' ? (
            <ScheduleTable rows={monthTableRows} completions={completions} year={year} month={month}
              getChipStyle={getChipStyle}
              onToggleDone={(zone, m) => { if (requireAdmin()) setCompletionPrompt({ zoneId: zone.id, zoneName: zone.name, grade: zone.grade, num: m.num, dateStr: format(m.date, 'yyyy-MM-dd'), isCompleted: completions.has(`${zone.id}_${m.num}`) }); }}
            />
          ) : (
          <>
          {/* Day-of-week header */}
          <div className="cal-dow grid grid-cols-7 border-b border-gray-100">
            {dowOrder.map(d => (
              <div key={d} className={`py-2.5 text-center text-xs font-semibold ${
                d === 0 ? 'bg-red-50 text-red-600' : d === 6 ? 'bg-blue-50 text-blue-600' : 'bg-gray-50 text-gray-600'
              }`}>{DOW_LABELS[d]}</div>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="cal-grid grid grid-cols-7">
              {grid.map((cell, idx) => {
                const { day, isOther } = cell;
                const dateStr = `${cell.year}-${String(cell.month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const calibEvts = calibByDate[dateStr] || [];
                const schedEvts = scheduleByDate[dateStr] || [];
                const tempEvts = tempByDate[dateStr] || [];

                const isToday = !isOther && isCurrentMonth && day === todayDate;
                const isSelected = dateStr === selectedDay;
                const isDragOver = dragOverDay === dateStr;
                const dow = new Date(dateStr + 'T00:00:00').getDay();

                // 비통합(공조·용수 등)은 유형별 합산, 통합(질소·압축 대분류)은 대분류별 float 합산
                const catPts = { nonComb: { s:0, f:0, l:0, p:0 }, combined: {} };
                schedEvts.forEach(({ zone }) => {
                  const s=zone.points_surface||0, f=zone.points_float||0, l=zone.points_fall||0, p=zone.points_particle||0;
                  if (isCombinedCat(zone.category, scheduleConfig)) {
                    const major = getMajorCat(zone.category, scheduleConfig);
                    catPts.combined[major] = (catPts.combined[major] || 0) + f;
                  } else {
                    catPts.nonComb.s+=s; catPts.nonComb.f+=f; catPts.nonComb.l+=l; catPts.nonComb.p+=p;
                  }
                });
                const tempPtsTotal = tempEvts.reduce((t,e)=>t+(e.points_surface||0)+(e.points_float||0)+(e.points_fall||0)+(e.points_particle||0), 0);
                const combTotal = Object.values(catPts.combined).reduce((a,b)=>a+b,0);
                const hasPts = catPts.nonComb.s+catPts.nonComb.f+catPts.nonComb.l+catPts.nonComb.p+combTotal+tempPtsTotal > 0;
                const nextCellData = grid[idx + 1];
                const belowCellData = grid[idx + 7];
                const boundaryRight = (isOther && nextCellData && !nextCellData.isOther)
                                   || (!isOther && nextCellData?.isOther);
                const boundaryBottom = (isOther && belowCellData && !belowCellData.isOther)
                                    || (!isOther && belowCellData?.isOther);
                const isHol = !isOther && !!holidays[dateStr];
                const isBlocked = !isOther && blockedDates.has(dateStr);

                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedDay(dateStr === selectedDay ? null : dateStr)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverDay(dateStr); }}
                    onDragLeave={(e) => {
                      if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDragOverDay(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverDay(null);
                      try {
                        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                        if (data.zoneId !== undefined) handleDropOnDay(dateStr, data);
                      } catch {}
                    }}
                    className={`cal-day min-h-28 p-1.5 cursor-pointer transition-colors
                      ${boundaryRight ? 'border-r-2 border-r-gray-400' : 'border-r border-r-gray-100'}
                      ${boundaryBottom ? 'border-b-2 border-b-gray-400' : 'border-b border-b-gray-100'}
                      ${isDragOver ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' :
                        isOther ? 'bg-gray-100/90' :
                        isSelected ? (dow === 6 ? 'bg-blue-100' : (dow === 0 || isHol) ? 'bg-red-100' : 'bg-blue-50') :
                        isToday ? 'bg-blue-50/50' :
                        dow === 6 ? 'bg-blue-50/60' :
                        (dow === 0 || isHol) ? 'bg-red-50/60' :
                        'hover:bg-gray-50'
                      }`}
                  >
                    {(() => {
                      const dateNumClass = `text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full shrink-0 ${
                        isOther ? 'text-gray-300' :
                        isToday ? 'bg-blue-600 text-white' :
                        (dow === 0 || isHol) ? 'text-red-500' :
                        dow === 6 ? 'text-blue-500' : 'text-gray-700'
                      }`;
                      const majorAbbr = { '질소가스': '질', '압축공기': '압', '용수': '용' };
                      const majorChipCls = { '질소가스': 'bg-purple-100 text-purple-700', '압축공기': 'bg-yellow-100 text-yellow-700', '용수': 'bg-teal-100 text-teal-700' };
                      const ptsChips = hasPts ? (
                        <div className={`flex flex-wrap gap-0.5 ${isOther ? 'opacity-50' : ''}`}>
                          {catPts.nonComb.s > 0 && <span className="text-[9px] leading-none bg-green-50 text-green-700 px-0.5 py-0.5 rounded">표{catPts.nonComb.s}</span>}
                          {catPts.nonComb.f > 0 && <span className="text-[9px] leading-none bg-blue-50 text-blue-700 px-0.5 py-0.5 rounded">부{catPts.nonComb.f}</span>}
                          {catPts.nonComb.l > 0 && <span className="text-[9px] leading-none bg-orange-50 text-orange-700 px-0.5 py-0.5 rounded">낙{catPts.nonComb.l}</span>}
                          {catPts.nonComb.p > 0 && <span className="text-[9px] leading-none bg-pink-50 text-pink-700 px-0.5 py-0.5 rounded">입{catPts.nonComb.p}</span>}
                          {Object.entries(catPts.combined).map(([major, v]) => v > 0 && (
                            <span key={major} className={`text-[9px] leading-none px-0.5 py-0.5 rounded ${majorChipCls[major] || 'bg-purple-100 text-purple-700'}`}>{majorAbbr[major] || major.slice(0, 1)}{v}</span>
                          ))}
                          {tempPtsTotal > 0 && <span className="text-[9px] leading-none bg-gray-100 text-gray-500 px-0.5 py-0.5 rounded">임{tempPtsTotal}</span>}
                        </div>
                      ) : null;
                      const blockedBadge = isBlocked
                        ? <span className="text-[9px] leading-none text-purple-600 bg-purple-100 px-1 py-0.5 rounded shrink-0">비움</span>
                        : null;
                      return isHol ? (
                        <div className="mb-0.5">
                          <div className="flex items-center gap-0.5">
                            <div className={dateNumClass}>{day}</div>
                            <span className="text-[9px] leading-none text-red-500 truncate">{holidays[dateStr]}</span>
                            {blockedBadge}
                          </div>
                          {ptsChips && <div className="mt-0.5">{ptsChips}</div>}
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-0.5 mb-0.5">
                          <div className="flex items-center gap-0.5">
                            <div className={dateNumClass}>{day}</div>
                            {blockedBadge}
                          </div>
                          {ptsChips}
                        </div>
                      );
                    })()}

                    <div className={`cal-events flex flex-col gap-0.5 ${isOther ? 'opacity-50' : ''}`}>
                      {calibEvts.map((c, i) => (
                        <div
                          key={`c${i}`}
                          className={`text-xs px-1 py-0.5 rounded truncate ${dDayColor(c.next_calib_date)}`}
                          title={`${c.name} (${dDayText(c.next_calib_date)})`}
                        >{c.name}</div>
                      ))}
                      {/* 임시일정은 항상 정규 일정보다 위에 표시 */}
                      {tempEvts.map((t, i) => (
                        <div
                          key={`t${i}`}
                          onClick={(e) => e.stopPropagation()}
                          className={`text-xs px-1 py-0.5 rounded truncate bg-orange-50 border border-orange-200 text-orange-600 ${t.done ? 'line-through opacity-60' : ''}`}
                          title={`${t.name}[임시]${t.done ? ' [완료]' : ''}`}
                        >{t.name}[임시]</div>
                      ))}
                      {schedEvts.map(({ zone, measurement }, i) => {
                        const bounds = getDragBounds(measurement, scheduleAvoid);
                        const label = `${zone.name}[${zone.grade}]-${measurement.num}`;
                        const noPts = !(zone.points_surface || zone.points_float || zone.points_fall || zone.points_particle);
                        const isDone = completions.has(`${zone.id}_${measurement.num}`);
                        return (
                          <div
                            key={`s${i}`}
                            draggable={!isDone && adminUnlocked}
                            onDragStart={(!isDone && adminUnlocked) ? (e) => {
                              e.stopPropagation();
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', JSON.stringify({
                                zoneId: zone.id,
                                num: measurement.num,
                                type: measurement.type,
                                minDateStr: format(bounds.min, 'yyyy-MM-dd'),
                                maxDateStr: format(bounds.max, 'yyyy-MM-dd'),
                                fromDateStr: format(measurement.date, 'yyyy-MM-dd'),
                                spanMonths: measurement.spanMonths || 1,
                                isFirst: !!measurement.isFirst,
                              }));
                            } : undefined}
                            onDragEnd={(!isDone && adminUnlocked) ? () => setDragOverDay(null) : undefined}
                            onClick={(e) => e.stopPropagation()}
                            className={`text-xs rounded overflow-hidden flex items-stretch min-w-0 ${isDone ? 'opacity-60 cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
                            style={getChipStyle(zone.category, zone.grade)}
                            title={`${label}${noPts ? ' [포인트 입력 필요]' : ''}${isDone ? ' [완료]' : measurement.isFirst ? ' [첫 측정]' : measurement.isLast ? ' [마지막 측정]' : ''}`}
                          >
                            {measurement.isFirst && <span className="w-1 shrink-0" style={{ backgroundColor: '#22c55e' }} />}
                            <span className={`truncate flex-1 px-1 py-0.5 ${isDone ? 'line-through' : ''} ${(measurement.isFirst || measurement.isLast) ? 'font-semibold' : ''}`}>
                              {noPts && <span className="text-red-600 font-bold">*</span>}{label}
                            </span>
                            {measurement.isLast && <span className="w-1 shrink-0" style={{ backgroundColor: '#ef4444' }} />}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </>
          )}

          {/* Legend */}
          <div className="cal-legend flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />만료됨
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-orange-100 border border-orange-200 inline-block" />7일 이내
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-yellow-50 border border-yellow-200 inline-block" />이번달 교정
            </div>
            {/* 범례는 대분류만 — 소분류는 대분류 색상을 따름 */}
            {MAJOR_CATS.map(cat => {
              const c = chipColors[`cat_${cat}`] ?? DEFAULT_CHIP_COLORS[`cat_${cat}`] ?? { bg: '#f3f4f6', border: '#e5e7eb' };
              return (
                <button
                  key={cat}
                  onClick={e => {
                    const x = Math.max(10, Math.min(e.clientX - 104, window.innerWidth - 224));
                    const y = Math.max(10, e.clientY - 280);
                    setColorPicker({ key: `cat_${cat}`, label: cat, type: 'cat', x, y });
                  }}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors group"
                  title="클릭하여 색상 변경"
                >
                  <span className="w-3 h-3 rounded inline-block border transition-transform group-hover:scale-125"
                    style={{ backgroundColor: c?.bg, borderColor: c?.border }} />
                  {cat}
                  <span className="text-[9px] text-gray-300 group-hover:text-blue-400 leading-none">✎</span>
                </button>
              );
            })}
            {/* Grade text — click to edit text color */}
            <div className="flex items-center gap-2 text-xs">
              {['P1', 'P2', 'P3', '유지관리'].map(grade => {
                const c = chipColors[`grade_${grade}`] ?? DEFAULT_CHIP_COLORS[`grade_${grade}`];
                return (
                  <button
                    key={grade}
                    onClick={e => {
                      const x = Math.max(10, Math.min(e.clientX - 104, window.innerWidth - 224));
                      const y = Math.max(10, e.clientY - 220);
                      setColorPicker({ key: `grade_${grade}`, label: grade, type: 'grade', x, y });
                    }}
                    className="font-semibold hover:opacity-60 transition-opacity group flex items-center gap-0.5"
                    style={{ color: c?.text }}
                    title="클릭하여 색상 변경"
                  >
                    {grade}<span className="text-[9px] text-gray-300 group-hover:text-blue-400 leading-none font-normal">✎</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-flex items-stretch w-5 h-3 rounded overflow-hidden border border-gray-200 bg-white">
                <span className="w-1 shrink-0" style={{ backgroundColor: '#22c55e' }} />
              </span>첫 측정
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-flex items-stretch w-5 h-3 rounded overflow-hidden border border-gray-200 bg-white">
                <span className="flex-1" />
                <span className="w-1 shrink-0" style={{ backgroundColor: '#ef4444' }} />
              </span>마지막 측정
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-64 shrink-0 flex flex-col gap-3">
          {/* Selected day events */}
          {selectedDay && (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col flex-1 min-h-0">
              <div className={`px-4 py-3 ${hdBg} text-white shrink-0 flex items-start justify-between gap-2`}>
                <div>
                  <p className={`text-xs ${hdSub}`}>{selectedDay.slice(0,4)}년 {MONTH_KR[parseInt(selectedDay.slice(5,7)) - 1]} · {DOW_LABELS[selDow]}요일</p>
                  <p className="text-lg font-bold">{parseInt(selectedDay.slice(8,10))}일 일정</p>
                  {isSelHol && (
                    <p className={`text-xs mt-0.5 ${hdSub}`}>🎌 {holidays[selectedDay]}</p>
                  )}
                </div>
                {(selectedScheduleEvents.length > 0 || blockedDates.has(selectedDay)) && (
                  <label className="flex items-center gap-1 text-xs text-white/90 cursor-pointer select-none shrink-0 whitespace-nowrap"
                    title="체크 시 이 날의 모든 일정을 다른 날로 옮기고, 이 날에는 어떤 일정도 배치되지 않습니다">
                    <input type="checkbox" checked={blockedDates.has(selectedDay)}
                      onChange={e => handleToggleBlockDay(selectedDay, e.target.checked)} className="rounded" />
                    일정비우기
                  </label>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">

              {selectedCalibEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-orange-50 border-b border-orange-100">
                    <span className="text-xs font-semibold text-orange-600">교정 일정</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {selectedCalibEvents.map(c => (
                      <div key={c.id} className="px-4 py-3">
                        <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">S/N: {c.sn || '-'}</p>
                        <p className={`text-xs font-bold mt-1 ${
                          differenceInDays(parseISO(c.next_calib_date), today) < 0 ? 'text-red-600' : 'text-orange-500'
                        }`}>{dDayText(c.next_calib_date)}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* 임시일정은 항상 정규 측정 일정보다 위에 표시 */}
              {selectedTempEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-orange-50 border-b border-orange-100">
                    <span className="text-xs font-semibold text-orange-600">임시 일정 ({selectedTempEvents.length}건)</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {selectedTempEvents.map(t => (
                      <div key={t.id} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <div className="flex items-center gap-1">
                            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-orange-50 border border-orange-200 text-orange-600">임시</span>
                            {t.done && <span className="text-xs bg-green-500 text-white px-1 py-0.5 rounded font-bold">✓완료</span>}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => { if (requireAdmin()) { setEditingTempId(t.id); setEditingTempName(t.name); } }}
                              className="text-xs text-gray-400 hover:text-blue-500 leading-none"
                              title="이름 수정"
                            >✎</button>
                            <button
                              onClick={() => { if (!requireAdmin()) return; setDeleteTempPrompt(t); }}
                              className="text-xs text-gray-400 hover:text-red-500 leading-none"
                              title="삭제"
                            >✕</button>
                          </div>
                        </div>
                        {editingTempId === t.id ? (
                          <input
                            autoFocus
                            className="text-sm font-medium text-gray-800 border border-blue-400 rounded px-1.5 py-0.5 w-full focus:outline-none"
                            value={editingTempName}
                            onChange={e => setEditingTempName(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onKeyDown={e => { if (e.key === 'Enter') renameTempSchedule(t, editingTempName); if (e.key === 'Escape') setEditingTempId(null); }}
                            onBlur={() => renameTempSchedule(t, editingTempName)}
                          />
                        ) : (
                          <p
                            className={`text-sm font-medium cursor-pointer ${t.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}
                            title="더블클릭하여 완료 처리"
                            onDoubleClick={() => toggleTempDone(t)}
                          >{t.name}</p>
                        )}
                        {(t.points_surface || t.points_float || t.points_fall || t.points_particle) ? (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {t.points_surface > 0 && <span className="text-[10px] bg-green-50 text-green-600 px-1 py-0.5 rounded">표면균 {t.points_surface}pt</span>}
                            {t.points_float > 0 && <span className="text-[10px] bg-blue-50 text-blue-600 px-1 py-0.5 rounded">부유균 {t.points_float}pt</span>}
                            {t.points_fall > 0 && <span className="text-[10px] bg-orange-50 text-orange-600 px-1 py-0.5 rounded">낙하균 {t.points_fall}pt</span>}
                            {t.points_particle > 0 && <span className="text-[10px] bg-purple-50 text-purple-600 px-1 py-0.5 rounded">부유입자 {t.points_particle}pt</span>}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {selectedDay && (selectedScheduleEvents.length > 0 || blockedDates.has(selectedDay)) && (
                <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-blue-600 whitespace-nowrap">측정일정({selectedScheduleEvents.length}건)</span>
                  {selectedScheduleEvents.length > 0 && (
                    <button onClick={() => addAllMeasTodos(selectedDay)}
                      className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 shrink-0"
                      title="이 날의 모든 측정을 할일 알람으로 한 번에 추가">
                      🔔 전체알람 추가
                    </button>
                  )}
                </div>
              )}

              {blockedDates.has(selectedDay) && selectedScheduleEvents.length === 0 && (
                <p className="px-4 py-3 text-sm text-gray-400">이 날은 일정비우기로 설정되어 있습니다.</p>
              )}

              {selectedScheduleEvents.length > 0 && (
                <>
                  <div className="divide-y divide-gray-50">
                    {selectedScheduleEvents.map(({ zone, measurement }) => {
                      const bounds = getDragBounds(measurement, scheduleAvoid);
                      const compKey = `${zone.id}_${measurement.num}`;
                      const isDone = completions.has(compKey);
                      return (
                        <div
                          key={`${zone.id}-${measurement.num}`}
                          className={`px-4 py-2.5 cursor-pointer select-none ${isDone ? 'bg-green-50/60' : 'hover:bg-gray-50/50'}`}
                          style={{
                            borderLeft: measurement.isFirst ? '3px solid #22c55e' : measurement.isLast ? '3px solid #ef4444' : undefined,
                          }}
                          onDoubleClick={() => { if (requireAdmin()) setCompletionPrompt({ zoneId: zone.id, zoneName: zone.name, grade: zone.grade, num: measurement.num, dateStr: selectedDay, isCompleted: isDone }); }}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <div className="flex items-center gap-1">
                              <span className="text-xs font-medium px-1.5 py-0.5 rounded" style={getChipStyle(zone.category, zone.grade)}>
                                {zone.grade}
                              </span>
                              {measurement.isFirst && <span className="text-xs text-green-600 font-bold">첫측정</span>}
                              {measurement.isLast && <span className="text-xs text-red-600 font-bold">마지막</span>}
                              {isDone && <span className="text-xs bg-green-500 text-white px-1 py-0.5 rounded font-bold">✓완료</span>}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={e => { e.stopPropagation(); toggleMeasTodo(zone, measurement, selectedDay); }}
                                className={`text-sm leading-none ${hasMeasTodo(zone, measurement, selectedDay) ? 'text-orange-500' : 'text-gray-300 hover:text-orange-400'}`}
                                title={hasMeasTodo(zone, measurement, selectedDay) ? '할일 알람 추가됨 (클릭 해제)' : '이 측정을 할일 알람으로 추가'}
                              >{hasMeasTodo(zone, measurement, selectedDay) ? '🔔' : '🔕'}</button>
                              <span className="text-xs text-gray-400">#{measurement.num} / {totalCount(zone)}</span>
                            </div>
                          </div>
                          <p className={`text-sm font-medium break-words ${isDone ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                            {zone.name}[{zone.grade}]
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            측정주기: {format(bounds.min, 'MM/dd')}~{format(bounds.max, 'MM/dd')}
                          </p>
                          {!(zone.points_surface || zone.points_float || zone.points_fall || zone.points_particle) && (
                            <p className="text-xs font-bold text-red-600 mt-0.5">포인트 입력 필요</p>
                          )}
                          {(zone.points_surface || zone.points_float || zone.points_fall || zone.points_particle) ? (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {isCombinedCat(zone.category, scheduleConfig) ? (
                                <span className="text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded font-medium">
                                  {getMajorCat(zone.category, scheduleConfig)} {zone.points_float || 0}pt
                                </span>
                              ) : (
                                <>
                                  {zone.points_surface > 0 && <span className="text-[10px] bg-green-50 text-green-600 px-1 py-0.5 rounded">표면균 {zone.points_surface}pt</span>}
                                  {zone.points_float > 0 && <span className="text-[10px] bg-blue-50 text-blue-600 px-1 py-0.5 rounded">부유균 {zone.points_float}pt</span>}
                                  {zone.points_fall > 0 && <span className="text-[10px] bg-orange-50 text-orange-600 px-1 py-0.5 rounded">낙하균 {zone.points_fall}pt</span>}
                                  {zone.points_particle > 0 && <span className="text-[10px] bg-pink-50 text-pink-600 px-1 py-0.5 rounded">부유입자 {zone.points_particle}pt</span>}
                                </>
                              )}
                            </div>
                          ) : null}
                          {!isDone && <p className="text-[10px] text-gray-300 mt-1">더블클릭으로 완료 처리</p>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {selectedCalibEvents.length === 0 && selectedScheduleEvents.length === 0 && selectedTempEvents.length === 0 && !blockedDates.has(selectedDay) && (
                <p className="px-4 py-3 text-sm text-gray-400">일정 없음</p>
              )}
              </div>
              <div className="px-3 py-2 border-t border-gray-100 shrink-0">
                <button
                  onClick={() => {
                    if (!requireAdmin()) return;
                    if (blockedDates.has(selectedDay)) { showError('일정비우기가 체크되어있습니다'); return; }
                    setAddSchedName('');
                    setAddSchedPts({ surface: '', float: '', fall: '', particle: '' });
                    setAddSchedPopup({ date: selectedDay });
                  }}
                  className="w-full py-1.5 text-sm font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors"
                >+ 일정 추가</button>
              </div>
            </div>
          )}

          {/* AHU plan */}
          {ahuTasks.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600">🔧 AHU 계획</p>
              </div>
              <div className="divide-y divide-gray-50 max-h-52 overflow-y-auto">
                {ahuTasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={`text-sm shrink-0 ${t.done ? 'text-green-500' : 'text-gray-300'}`}>{t.done ? '✓' : '○'}</span>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm block truncate ${t.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{t.ahuName}</span>
                      <span className="text-xs text-gray-400">{t.month}월 · 올해 {t.nth}번째</span>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                      t.done ? 'bg-green-100 text-green-600' :
                      t.month === month ? 'bg-yellow-100 text-yellow-700' :
                      t.month > month ? 'bg-blue-50 text-blue-500' : 'bg-gray-100 text-gray-400'
                    }`}>{t.done ? '완료' : t.month === month ? '이번달' : `${t.month}월`}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Monitoring progress — 이번 달 측정 일정을 구역별로 묶어 완료 현황을 보여준다.
              사이드바(w-64 flex-col)가 달력과 같은 높이로 늘어나 있으므로 이 패널이
              flex-1로 남은 높이를 모두 차지해 달력과 같은 크기가 되고, 목록도 잘리지
              않고 스크롤로 모든 구역을 볼 수 있다. */}
          {monthTableRows.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col flex-1 min-h-[240px]">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between shrink-0">
                <p className="text-xs font-semibold text-gray-600">📋 모니터링 현황</p>
                <span className={`text-xs font-bold ${monCompleteRate === 100 ? 'text-green-600' : 'text-blue-600'}`}>{monCompleteRate}%</span>
              </div>
              <div className="px-4 pt-3 shrink-0">
                <div className="w-full bg-gray-100 rounded-full h-2 mb-2 overflow-hidden">
                  <div className={`h-2 rounded-full ${monCompleteRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${monCompleteRate}%` }} />
                </div>
                <p className="text-xs text-gray-500 mb-2">이번 달 {monthTableRows.length}건 중 {monthDoneRows.length}건 완료</p>
              </div>
              <div className="flex border-b border-gray-100 shrink-0">
                {[
                  { key: 'all', label: `전체 ${monthTableRows.length}` },
                  { key: 'done', label: `측정완료 ${monthDoneRows.length}` },
                  { key: 'pending', label: `예정 ${monthPendingRows.length}` },
                ].map(t => (
                  <button
                    key={t.key}
                    onClick={() => setMonTab(t.key)}
                    className={`flex-1 py-1.5 text-[11px] font-medium border-b-2 -mb-px transition-colors ${
                      monTab === t.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
                    }`}
                  >{t.label}</button>
                ))}
              </div>
              <div className="divide-y divide-gray-50 flex-1 min-h-0 overflow-y-auto">
                {monTabZoneGroups.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-gray-400 text-center">해당 항목이 없습니다.</p>
                ) : monTabZoneGroups.map(g => (
                  <div key={g.zone.id} className="px-4 py-2.5">
                    <p className="text-xs font-medium text-gray-700 mb-1.5 truncate">{g.zone.name}[{g.zone.grade}]</p>
                    <div className="flex flex-wrap gap-1.5">
                      {g.occurrences.map((occ, i) => {
                        const isDone = completions.has(`${g.zone.id}_${occ.measurement.num}`);
                        return (
                          <button
                            key={`${occ.zone.id}-${occ.measurement.num}-${i}`}
                            onClick={() => setSelectedDay(occ.ds)}
                            className={`text-[11px] px-1.5 py-0.5 rounded border flex items-center gap-1 transition-colors ${
                              isDone ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                            }`}
                            title={`${g.zone.name}[${g.zone.grade}] · ${occ.ds}${isDone ? ' [완료]' : ''}`}
                          >
                            <span>{isDone ? '✓' : '○'}</span>
                            <span className="font-medium">{occ.monthIdx}/{occ.monthTotal}</span>
                            <span className="text-gray-400">{occ.ds.slice(2).replace(/-/g, '/')}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 표로보기: 이번 달 측정 일정 목록 (더블클릭으로 완료 처리)
const PT_TYPES = [
  { key: 'float', label: '부', cls: 'text-blue-600' },
  { key: 'fall', label: '낙', cls: 'text-orange-600' },
  { key: 'surface', label: '표', cls: 'text-green-600' },
  { key: 'particle', label: '입', cls: 'text-pink-600' },
];
const MAJOR_PT = { '질소가스': { label: '질', cls: 'text-purple-600' }, '압축공기': { label: '압', cls: 'text-yellow-700' } };

// 구역 1건의 포인트 breakdown 스팬들 (통합 대분류는 하나로, 그 외 부/낙/표/입)
function zonePtSpans(zone) {
  if (isCombinedCat(zone.category)) {
    const m = MAJOR_PT[getMajorCat(zone.category)] || { label: getMajorCat(zone.category).slice(0, 1), cls: 'text-purple-600' };
    const v = zone.points_float || 0;
    return v > 0 ? [<span key="c" className={`text-[11px] ${m.cls}`}>{m.label}{v}</span>] : [<span key="c" className="text-[11px] text-gray-300">—</span>];
  }
  const sp = PT_TYPES.map(t => {
    const v = zone[`points_${t.key}`] || 0;
    return v > 0 ? <span key={t.key} className={`text-[11px] ${t.cls}`}>{t.label}{v}</span> : null;
  }).filter(Boolean);
  return sp.length ? sp : [<span key="0" className="text-[11px] text-gray-300">—</span>];
}

// 포인트 컬럼 정의 — 질소/압축은 별도 컬럼(통합값), 부/낙/표/입자는 비-가스 값
const PT_CLS = { float: 'text-blue-600', fall: 'text-orange-600', surface: 'text-green-600', particle: 'text-pink-600', nitro: 'text-purple-600', comp: 'text-yellow-700' };
function ptValue(zone, key) {
  const major = getMajorCat(zone.category);
  if (key === 'nitro') return major === '질소가스' ? (zone.points_float || 0) : 0;
  if (key === 'comp') return major === '압축공기' ? (zone.points_float || 0) : 0;
  return isCombinedCat(zone.category) ? 0 : (zone[`points_${key}`] || 0);
}
const SCHED_COL_META = {
  date: { label: '날짜', w: 92, align: 'left' },
  dow: { label: '요일', w: 48, align: 'center' },
  zone: { label: '구분', w: 230, align: 'left' },
  num: { label: '회차', w: 70, align: 'center' },
  float: { label: '부', w: 50, align: 'center', pt: true },
  fall: { label: '낙', w: 50, align: 'center', pt: true },
  surface: { label: '표', w: 50, align: 'center', pt: true },
  particle: { label: '입자', w: 56, align: 'center', pt: true },
  nitro: { label: '질소', w: 56, align: 'center', pt: true },
  comp: { label: '압축', w: 56, align: 'center', pt: true },
  status: { label: '상태', w: 64, align: 'center' },
};
const SCHED_DEFAULT_ORDER = ['date', 'dow', 'zone', 'num', 'float', 'fall', 'surface', 'particle', 'nitro', 'comp', 'status'];
const PT_KEYS = ['float', 'fall', 'surface', 'particle', 'nitro', 'comp'];

function ScheduleTable({ rows, completions, year, month, getChipStyle, onToggleDone }) {
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const [colW, setColW] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('em-sched-table-cols')); if (s && typeof s === 'object') return s; } catch { /* ignore */ }
    return {};
  });
  const [colOrder, setColOrder] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('em-sched-table-order'));
      if (Array.isArray(s)) { const valid = s.filter(k => SCHED_COL_META[k]); SCHED_DEFAULT_ORDER.forEach(k => { if (!valid.includes(k)) valid.push(k); }); return valid; }
    } catch { /* ignore */ }
    return [...SCHED_DEFAULT_ORDER];
  });
  const [dragKey, setDragKey] = useState(null);
  useEffect(() => { try { localStorage.setItem('em-sched-table-cols', JSON.stringify(colW)); } catch { /* ignore */ } }, [colW]);
  useEffect(() => { try { localStorage.setItem('em-sched-table-order', JSON.stringify(colOrder)); } catch { /* ignore */ } }, [colOrder]);

  const width = k => colW[k] ?? SCHED_COL_META[k].w;
  function startResize(e, key) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = width(key);
    const onMove = ev => setColW(prev => ({ ...prev, [key]: Math.max(32, startW + ev.clientX - startX) }));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }
  function reorder(fromKey, toKey) {
    if (!fromKey || fromKey === toKey) return;
    setColOrder(prev => { const arr = prev.filter(k => k !== fromKey); const ti = arr.indexOf(toKey); if (ti < 0) return prev; arr.splice(ti, 0, fromKey); return arr; });
  }

  // 날짜별 그룹 + 컬럼별 합계
  const dayGroups = [];
  let cur = null;
  rows.forEach(r => {
    if (!cur || cur.ds !== r.ds) { cur = { ds: r.ds, items: [], sum: {} }; PT_KEYS.forEach(k => cur.sum[k] = 0); dayGroups.push(cur); }
    cur.items.push(r);
    PT_KEYS.forEach(k => { cur.sum[k] += ptValue(r.zone, k); });
  });

  const cellBase = 'px-2 py-1.5 border border-gray-100 text-xs';

  // 셀 렌더 (컬럼 key별)
  function bodyCell(key, ctx) {
    const { zone, measurement, ri, g, dow, dowCls } = ctx;
    const done = completions.has(`${zone.id}_${measurement.num}`);
    const meta = SCHED_COL_META[key];
    const alignCls = meta.align === 'left' ? '' : 'text-center';
    if (key === 'date') return <td key={key} className={`${cellBase} font-semibold ${dowCls}`}>{ri === 0 ? g.ds : ''}</td>;
    if (key === 'dow') return <td key={key} className={`${cellBase} text-center font-semibold ${dowCls}`}>{ri === 0 ? DOW[dow] : ''}</td>;
    if (key === 'zone') return <td key={key} className={`${cellBase} truncate`}><span className={`inline-block px-1 py-0.5 rounded ${done ? 'line-through opacity-60' : ''}`} style={getChipStyle(zone.category, zone.grade)}>{zone.name}[{zone.grade}]-{measurement.num}</span></td>;
    if (key === 'num') { const total = totalCount(zone) || measurement.num; const numCls = measurement.isFirst ? 'text-green-600' : measurement.isLast ? 'text-red-600' : 'text-gray-700'; return <td key={key} className={`${cellBase} text-center font-bold ${numCls}`}>{measurement.num}/{total}회</td>; }
    if (key === 'status') return <td key={key} className={`${cellBase} text-center`}><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{done ? '완료' : '예정'}</span></td>;
    // 포인트 컬럼
    const v = ptValue(zone, key);
    return <td key={key} className={`${cellBase} ${alignCls} ${v > 0 ? PT_CLS[key] + ' font-medium' : 'text-gray-300'}`}>{v || 0}</td>;
  }
  function sumCell(key, g) {
    if (key === 'dow') return <td key={key} className={`${cellBase} border-gray-200 text-center text-indigo-700 font-bold`}>합계</td>;
    if (key === 'zone') return <td key={key} className={`${cellBase} border-gray-200 text-right text-gray-500`}>{g.items.length}건</td>;
    if (PT_KEYS.includes(key)) return <td key={key} className={`${cellBase} border-gray-200 text-center font-bold ${g.sum[key] > 0 ? PT_CLS[key] : 'text-gray-300'}`}>{g.sum[key]}</td>;
    return <td key={key} className={`${cellBase} border-gray-200`}></td>;
  }

  return (
    <div className="print-unlock overflow-auto max-h-[calc(100vh-220px)]">
      <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: colOrder.reduce((s, k) => s + width(k), 0) }}>
        <colgroup>{colOrder.map(k => <col key={k} style={{ width: width(k) }} />)}</colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-gray-100 text-xs text-gray-600">
            {colOrder.map(key => {
              const meta = SCHED_COL_META[key];
              return (
                <th key={key}
                  onDragOver={e => { if (dragKey) e.preventDefault(); }}
                  onDrop={e => { const fk = e.dataTransfer.getData('col'); if (fk) { e.preventDefault(); reorder(fk, key); } setDragKey(null); }}
                  className={`relative px-2 py-2 font-semibold border border-gray-200 ${meta.align === 'left' ? 'text-left' : 'text-center'} ${meta.pt ? PT_CLS[key] : ''} ${dragKey === key ? 'opacity-40' : ''}`}>
                  <span draggable
                    onDragStart={e => { e.dataTransfer.setData('col', key); e.dataTransfer.effectAllowed = 'move'; setDragKey(key); }}
                    onDragEnd={() => setDragKey(null)}
                    className="cursor-move select-none" title="드래그하여 순서 변경">{meta.label}</span>
                  <span onMouseDown={e => startResize(e, key)} draggable={false} onDragStart={e => e.preventDefault()}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50" style={{ transform: 'translateX(50%)' }} title="드래그하여 너비 조절" />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={colOrder.length} className="px-3 py-8 text-center text-sm text-gray-400 border border-gray-200">{year}년 {month}월 예정된 측정 일정이 없습니다.</td></tr>
          )}
          {dayGroups.map(g => {
            const d = new Date(g.ds + 'T00:00:00');
            const dow = d.getDay();
            const dowCls = dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-600';
            return (
              <Fragment key={g.ds}>
                {g.items.map(({ zone, measurement }, ri) => {
                  const done = completions.has(`${zone.id}_${measurement.num}`);
                  return (
                    <tr key={`${zone.id}_${measurement.num}`}
                      onDoubleClick={() => onToggleDone(zone, measurement)}
                      className={`cursor-pointer hover:bg-blue-50/40 ${done ? 'bg-green-50/40' : ''}`}
                      title="더블클릭으로 완료 처리">
                      {colOrder.map(key => bodyCell(key, { zone, measurement, ri, g, dow, dowCls }))}
                    </tr>
                  );
                })}
                <tr className="bg-indigo-50 font-semibold">
                  {colOrder.map(key => sumCell(key, g))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
