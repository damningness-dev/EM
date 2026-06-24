import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchCalibration, fetchZones, fetchMonitoringData, fetchAnnualPlan, upsertZone, fetchGroups, upsertGroup, deleteGroup, fetchHolidays, upsertHoliday, deleteHoliday, fetchCompletions, setCompletion, deleteCompletion, fetchTempSchedules, addTempSchedule, deleteTempSchedule, fetchScheduleConfig, saveScheduleConfig } from '../lib/api';
import { parseISO, differenceInDays, format } from 'date-fns';
import { calcMeasurements, calcEndDate, totalCount, getDragBounds, NEXT_GRADE, GRADE_PRIORITY, NTH_LABEL, DOW_LABEL, buildHolidayMap, computeCascadeSchedules, optimizeMonthSchedule, setScheduleConfig, DEFAULT_SCHEDULE_SPECS, alignGroupSchedules } from '../lib/schedule';
import { GRADE_COLORS, CATEGORY_SECTION } from '../data/initialData';

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
const CYCLE_CATS = ['공조', '압축공기', '질소가스'];

function mergeScheduleConfig(backend) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_SPECS));
  if (backend && typeof backend === 'object') {
    for (const cat of CYCLE_CATS) {
      if (backend[cat]) {
        for (const g of CYCLE_GRADES) {
          if (Array.isArray(backend[cat][g])) base[cat][g] = backend[cat][g];
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

export default function CalendarView({ year: initYear, onYearChange }) {
  const today = new Date();
  const [year, setYear] = useState(initYear || today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState(null);

  const [calibration, setCalibration] = useState([]);
  const [zones, setZones] = useState([]);
  const [monitoring, setMonitoring] = useState({});
  const [annualPlan, setAnnualPlan] = useState({});
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState('zones'); // 'zones' | 'groups'
  const [dragOverDay, setDragOverDay] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [successToast, setSuccessToast] = useState(null);
  const successToastTimer = useRef(null);
  const [groups, setGroups] = useState([]);
  const [phasePrompt, setPhasePrompt] = useState(null); // { zoneId, zoneName, nextGrade, dateStr }
  const [newGroupName, setNewGroupName] = useState('');
  const [zonesCatFilter, setZonesCatFilter] = useState('전체');
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayRepeat, setNewHolidayRepeat] = useState(false);
  const [newHolidayRepeatType, setNewHolidayRepeatType] = useState('yearly');
  const [newHolidayNth, setNewHolidayNth] = useState(1);
  const [newHolidayDow, setNewHolidayDow] = useState(1);
  const [completions, setCompletions] = useState(new Set());
  const [completionPrompt, setCompletionPrompt] = useState(null); // {zoneId,zoneName,grade,num,dateStr,isCompleted}
  const [tempSchedules, setTempSchedules] = useState([]);
  const [addSchedPopup, setAddSchedPopup] = useState(null); // { date }
  const [addSchedName, setAddSchedName] = useState('');
  const [addSchedPts, setAddSchedPts] = useState({ surface: '', float: '', fall: '', particle: '' });
  const [chipColors, setChipColors] = useState(() => {
    try {
      const saved = localStorage.getItem('em-chip-colors');
      return saved ? { ...DEFAULT_CHIP_COLORS, ...JSON.parse(saved) } : { ...DEFAULT_CHIP_COLORS };
    } catch { return { ...DEFAULT_CHIP_COLORS }; }
  });
  const [colorPicker, setColorPicker] = useState(null); // { key, label, type:'cat'|'grade', x, y }
  const colorPickerRef = useRef(null);
  const [optimizePopup, setOptimizePopup] = useState(false);
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

  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    Promise.all([
      fetchCalibration(),
      fetchZones(),
      fetchMonitoringData(year, month),
      fetchAnnualPlan(year),
      fetchGroups(),
      fetchHolidays(),
      fetchCompletions(),
      fetchTempSchedules(),
      fetchScheduleConfig(),
    ]).then(([cal, zns, mon, plan, grps, hols, comps, temps, schedCfg]) => {
      setCalibration(cal);
      const mergedCfg = mergeScheduleConfig(schedCfg);
      setScheduleConfig(mergedCfg);
      setScheduleConfigState(mergedCfg);
      // 레거시 '청정등급' 분류 → '공조'로 이관 (청정등급은 이제 각 일정의 속성)
      const legacy = zns.filter(z => z.category === '청정등급');
      if (legacy.length) {
        legacy.forEach(z => upsertZone({ ...z, category: '공조' }));
        zns = zns.map(z => z.category === '청정등급' ? { ...z, category: '공조' } : z);
      }
      setZones(zns);
      setMonitoring(mon);
      setAnnualPlan(plan);
      setGroups(grps);
      setHolidayDefs(hols);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
      setTempSchedules(temps);
      setLoading(false);
    });
  }, [year, month]);

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

  // Calibration events by date string
  const calibByDate = {};
  calibration.forEach(c => {
    if (!c.next_calib_date) return;
    try {
      const key = c.next_calib_date.slice(0, 10);
      if (!calibByDate[key]) calibByDate[key] = [];
      calibByDate[key].push(c);
    } catch {}
  });

  // Schedule events by date string (all dates, no month filter)
  const scheduleByDate = useMemo(() => {
    const map = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      calcMeasurements(zone, holidays).forEach(m => {
        const key = format(m.date, 'yyyy-MM-dd');
        if (!map[key]) map[key] = [];
        map[key].push({ zone, measurement: m });
      });
    });
    return map;
  }, [zones, holidays, scheduleConfig]);

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
  const scheduledZonesCount = zones.filter(z => z.schedule_start && ['P1','P2','P3'].includes(z.grade)).length;

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

  function showError(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  function showSuccess(message) {
    setSuccessToast(message);
    if (successToastTimer.current) clearTimeout(successToastTimer.current);
    successToastTimer.current = setTimeout(() => setSuccessToast(null), 3000);
  }

  function getChipStyle(category, grade) {
    const cat = chipColors[`cat_${category}`] ?? DEFAULT_CHIP_COLORS[`cat_${category}`] ?? { bg: '#f3f4f6', border: '#e5e7eb' };
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

  async function handleSetZoneStart(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;

    // Validate: start date must not be before the previous grade's end date
    const PREV_GRADE = { P2: 'P1', P3: 'P2', '유지관리': 'P3' };
    const prevGrade = PREV_GRADE[zone.grade];
    if (dateStr && prevGrade) {
      const prevZone = zones.find(z =>
        z.name === zone.name && z.category === zone.category && z.grade === prevGrade
      );
      if (prevZone?.schedule_start) {
        const prevMs = calcMeasurements(prevZone);
        if (prevMs.length) {
          const prevEndDate = prevMs[prevMs.length - 1].baseDate;
          const newStart = new Date(dateStr + 'T00:00:00');
          if (newStart < prevEndDate) {
            showError(
              `${zone.grade} 시작일은 ${prevGrade} 종료예정일(${format(prevEndDate, 'yyyy.MM.dd')}) 이후로 설정해야 합니다.`
            );
            return;
          }
        }
      }
    }

    // Propagate to all zones in the same group
    let updatedZone;
    const group = groups.find(g => g.zoneIds.includes(zoneId));
    if (group) {
      const groupZones = zones.filter(z => group.zoneIds.includes(z.id));
      const updates = await Promise.all(
        groupZones.map(z => {
          const u = { ...z, schedule_start: dateStr || null, schedule_overrides: {} };
          return upsertZone(u).then(() => u);
        })
      );
      setZones(prev => prev.map(z => {
        const u = updates.find(u => u.id === z.id);
        return u || z;
      }));
      updatedZone = updates.find(u => u.id === zoneId);
      // 자동 측정주기 정렬: 주기가 긴 구역을 짧은 구역 측정일에 맞춤
      if (dateStr) {
        const withStart = updates.filter(z => z.schedule_start);
        if (withStart.length >= 2) await applyGroupAlignment(withStart);
      }
    } else {
      updatedZone = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
      await upsertZone(updatedZone);
      setZones(prev => prev.map(z => z.id === zoneId ? updatedZone : z));
    }

    // Auto-cascade: create/update P2→P3→유지관리 start dates
    if (dateStr && updatedZone && ['P1', 'P2', 'P3'].includes(updatedZone.grade)) {
      const startYear = new Date(dateStr).getFullYear();
      const cascadeHolidayMap = buildHolidayMap(holidayDefs, startYear, startYear + 4);
      const cascadeItems = computeCascadeSchedules(updatedZone, zones, cascadeHolidayMap);
      if (cascadeItems.length > 0) {
        const cascaded = [];
        for (const { zoneData } of cascadeItems) {
          const saved = await upsertZone(zoneData);
          cascaded.push(saved);
        }
        setZones(prev => {
          const next = [...prev];
          for (const cz of cascaded) {
            const idx = next.findIndex(z => z.id === cz.id);
            if (idx >= 0) next[idx] = cz; else next.push(cz);
          }
          return next;
        });
        showSuccess(`다음 단계 일정 ${cascadeItems.length}개가 자동 등록되었습니다.`);
      }
    }
  }

  async function handleOptimize() {
    const caps = {
      surface:  parseInt(optimizeCapacities.surface)  || 0,
      float:    parseInt(optimizeCapacities.float)    || 0,
      fall:     parseInt(optimizeCapacities.fall)     || 0,
      particle: parseInt(optimizeCapacities.particle) || 0,
      combined: parseInt(optimizeCapacities.combined) || 0,
    };
    const anySet = Object.values(caps).some(v => v > 0);
    if (!anySet) { showError('최소 하나의 포인트 최대값을 설정해주세요.'); return; }
    try { localStorage.setItem('em-daily-capacities', JSON.stringify(optimizeCapacities)); } catch {}
    setOptimizing(true);
    try {
      const overrides = optimizeMonthSchedule({
        zones, tempSchedules, completions, year, month, capacities: caps, holidayMap: holidays,
      });
      const zoneIds = Object.keys(overrides);
      if (!zoneIds.length) {
        showSuccess('재배치가 필요한 일정이 없습니다.');
        setOptimizePopup(false);
        return;
      }
      let movedCount = 0;
      const updates = [];
      for (const zid of zoneIds) {
        const zone = zones.find(z => String(z.id) === String(zid));
        if (!zone) continue;
        movedCount += Object.keys(overrides[zid]).length;
        const u = { ...zone, schedule_overrides: { ...(zone.schedule_overrides || {}), ...overrides[zid] } };
        await upsertZone(u);
        updates.push(u);
      }
      setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
      showSuccess(`${year}년 ${month}월 일정 ${movedCount}건을 재배치했습니다.`);
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

  // 일정그룹 정렬: 주기가 긴 구역의 측정일을 짧은(잦은) 구역 측정일에 맞춰 스냅
  async function applyGroupAlignment(groupZones) {
    const aligns = alignGroupSchedules(groupZones, holidays);
    if (!aligns.length) return 0;
    const updates = [];
    for (const a of aligns) {
      const z = groupZones.find(z => z.id === a.zoneId) || zones.find(z => z.id === a.zoneId);
      if (!z) continue;
      const u = { ...z, schedule_overrides: a.schedule_overrides };
      await upsertZone(u);
      updates.push(u);
    }
    if (updates.length) setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
    return updates.length;
  }

  async function handleSyncGroup(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    let groupZones = zones.filter(z => group.zoneIds.includes(z.id) && z.schedule_start);
    if (groupZones.length < 2) { showError('정렬하려면 시작일이 설정된 구역이 2개 이상이어야 합니다.'); return; }
    // 1) 시작일 동기화 (가장 잦은 구역 기준)
    const anchor = groupZones.reduce((best, z) => {
      return (GRADE_PRIORITY[z.grade] || 0) > (GRADE_PRIORITY[best.grade] || 0) ? z : best;
    });
    const toSync = groupZones.filter(z => z.id !== anchor.id && z.schedule_start !== anchor.schedule_start);
    const startUpdates = await Promise.all(
      toSync.map(z => {
        const u = { ...z, schedule_start: anchor.schedule_start, schedule_overrides: {} };
        return upsertZone(u).then(() => u);
      })
    );
    // 동기화 반영된 작업 집합 구성
    let working = zones.map(z => startUpdates.find(u => u.id === z.id) || z);
    if (startUpdates.length) setZones(working);
    groupZones = working.filter(z => group.zoneIds.includes(z.id) && z.schedule_start);
    // 2) 측정주기 정렬
    const aligned = await applyGroupAlignment(groupZones);
    showSuccess(`일정그룹 동기화 완료${aligned ? ` · 측정일 ${aligned}개 구역 정렬됨` : ''}`);
  }

  async function handleDropOnDay(dateStr, dragData) {
    const zone = zones.find(z => z.id === dragData.zoneId);
    if (!zone) return;

    if (dateStr < dragData.minDateStr || dateStr > dragData.maxDateStr) {
      const typeMsg = dragData.type === 'weekly' ? '해당 주간 내'
        : dragData.type === 'biweekly' ? '해당 주간 내'
        : dragData.type === 'monthly' ? '해당 월 내'
        : '동일 날짜';
      showError(`이동 불가: ${typeMsg}에서만 일정을 변경할 수 있습니다. (${dragData.minDateStr} ~ ${dragData.maxDateStr})`);
      return;
    }

    const updated = {
      ...zone,
      schedule_overrides: {
        ...(zone.schedule_overrides || {}),
        [String(dragData.num)]: dateStr,
      },
    };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === dragData.zoneId ? updated : z));
  }

  const selDow = selectedDay ? new Date(selectedDay + 'T00:00:00').getDay() : 0;
  const isSelHol = selectedDay ? !!holidays[selectedDay] : false;
  const hdBg = (selDow === 0 || isSelHol) ? 'bg-red-500' : selDow === 6 ? 'bg-blue-600' : 'bg-gray-600';
  const hdSub = (selDow === 0 || isSelHol) ? 'text-red-200' : selDow === 6 ? 'text-blue-200' : 'text-gray-300';

  return (
    <div className="p-6 space-y-5">

      {/* Error toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[200] bg-red-500 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 max-w-sm">
          <span className="text-base shrink-0 mt-0.5">⚠</span>
          <span className="text-sm font-medium flex-1 leading-snug">{toast}</span>
          <button onClick={() => setToast(null)} className="text-red-200 hover:text-white text-lg leading-none shrink-0">✕</button>
        </div>
      )}

      {/* Success toast */}
      {successToast && (
        <div className="fixed top-16 right-4 z-[200] bg-green-600 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 max-w-sm">
          <span className="text-base shrink-0 mt-0.5">✓</span>
          <span className="text-sm font-medium flex-1 leading-snug">{successToast}</span>
          <button onClick={() => setSuccessToast(null)} className="text-green-200 hover:text-white text-lg leading-none shrink-0">✕</button>
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
                }}
                className={`px-4 py-2 text-sm text-white rounded-lg ${completionPrompt.isCompleted ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}`}
              >{completionPrompt.isCompleted ? '완료 취소' : '완료 처리'}</button>
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
                onClick={async () => {
                  if (!addSchedName.trim()) return;
                  const entry = {
                    date: addSchedPopup.date,
                    name: addSchedName.trim(),
                    points_surface: parseInt(addSchedPts.surface) || 0,
                    points_float: parseInt(addSchedPts.float) || 0,
                    points_fall: parseInt(addSchedPts.fall) || 0,
                    points_particle: parseInt(addSchedPts.particle) || 0,
                  };
                  const saved = await addTempSchedule(entry);
                  setTempSchedules(prev => [...prev, saved]);
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
                {year}년 {MONTH_KR[month - 1]}의 하루 포인트가 설정값 초과 시 측정주기 내 여유일로 이동합니다.
                공조·질소가스·압축공기는 <b>각각 따로</b> 계산되며, 질소+압축공기는 합산도 확인합니다. (완료·임시 고정)
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
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">🗓 달력 설정</h3>
            <p className="text-xs text-gray-400 mb-4">달력의 시작 요일을 선택하세요.</p>
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
            <div className="flex justify-end">
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

      {/* Schedule settings drawer */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/30" onClick={() => setShowSettings(false)} />
          <div className="w-[520px] h-full bg-white shadow-2xl border-l border-gray-200 flex flex-col">
            {/* Drawer header */}
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">모니터링 일정 설정</h2>
                <p className="text-xs text-gray-400 mt-0.5">{scheduledZonesCount}개 구역 설정됨 · {groups.length}개 그룹</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0">
              {[['zones','구역 일정'],['groups','일정그룹 관리'],['holidays','공휴일'],['cycle','측정주기']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSettingsTab(key)}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    settingsTab === key
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >{label}</button>
              ))}
            </div>

            {/* ── 구역 일정 탭 ── */}
            {settingsTab === 'zones' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                {/* Category sub-tabs */}
                <div className="flex gap-1.5 px-4 py-2.5 border-b border-gray-100 shrink-0">
                  {['전체', '공조', '질소가스', '압축공기'].map(cat => (
                    <button
                      key={cat}
                      onClick={() => setZonesCatFilter(cat)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        zonesCatFilter === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >{cat}</button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {(zonesCatFilter === '전체' ? ['공조', '압축공기', '질소가스'] : [zonesCatFilter]).map(cat => {
                    const catGroups = zoneGroups.filter(g => g.category === cat);
                    if (!catGroups.length) return null;
                    return (
                      <div key={cat}>
                        <div className={`px-4 py-2 border-b sticky top-0 z-10 ${CATEGORY_SECTION[cat]?.bg || 'bg-gray-50'} ${CATEGORY_SECTION[cat]?.border || 'border-gray-100'}`}>
                          <span className={`text-xs font-bold ${CATEGORY_SECTION[cat]?.text || 'text-gray-500'}`}>{cat}</span>
                          <span className={`ml-2 text-xs opacity-70 ${CATEGORY_SECTION[cat]?.text || 'text-gray-400'}`}>{catGroups.length}개 구역</span>
                        </div>
                        {catGroups.map(group => {
                          const groupKey = `${group.category}_${group.name}`;
                          const isExpanded = expandedGroups.has(groupKey);
                          const myGroup = groups.find(g => group.zones.some(z => g.zoneIds.includes(z.id)));
                          const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
                          const activeZone = group.zones.find(zone => {
                            if (!zone.schedule_start) return false;
                            const startDate = new Date(zone.schedule_start + 'T00:00:00');
                            if (startDate > todayMidnight) return false;
                            const ms = calcMeasurements(zone);
                            if (!ms.length) return true;
                            return todayMidnight <= ms[ms.length - 1].baseDate;
                          });
                          const zonesToShow = isExpanded ? group.zones : (activeZone ? [activeZone] : []);
                          return (
                            <div key={groupKey} className="border-b border-gray-100">
                              {/* Group header */}
                              <div
                                className="px-4 pt-3 pb-2 flex items-center gap-2 cursor-pointer hover:opacity-70"
                                onClick={() => setExpandedGroups(prev => {
                                  const next = new Set(prev);
                                  if (next.has(groupKey)) next.delete(groupKey);
                                  else next.add(groupKey);
                                  return next;
                                })}
                              >
                                <span className="text-sm font-semibold text-gray-800 flex-1 truncate">{group.name}</span>
                                {myGroup && (
                                  <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded shrink-0">{myGroup.name}</span>
                                )}
                                {!isExpanded && activeZone && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${GRADE_COLORS[activeZone.grade] || 'bg-gray-100 text-gray-600'}`}>{activeZone.grade}</span>
                                )}
                                {!isExpanded && !activeZone && (
                                  <span className="text-xs text-gray-400 shrink-0">계획없음</span>
                                )}
                                <span className="text-gray-400 text-xs shrink-0">{isExpanded ? '▲' : '▼'}</span>
                              </div>
                              {!isExpanded && !activeZone && (
                                <div className="px-4 pb-3 text-xs text-gray-400 italic">계획일정 없음</div>
                              )}
                              {/* Grade rows */}
                              {zonesToShow.map(zone => {
                                const ms = calcMeasurements(zone);
                                const done = ms.filter(m => m.date <= todayMidnight).length;
                                const total = ms.length || totalCount(zone);
                                const endDate = calcEndDate(zone);
                                const isPastDue = endDate && endDate < todayMidnight && NEXT_GRADE[zone.grade];
                                return (
                                  <div key={zone.id} className={`px-3 py-2 ${isPastDue ? 'bg-amber-50/60' : ''}`}>
                                    <div className="flex items-start gap-2">
                                      {/* Grade + progress */}
                                      <div className="flex flex-col items-start gap-0.5 w-[68px] shrink-0">
                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>
                                          {zone.grade}
                                        </span>
                                        <span className={`text-xs tabular-nums ${isPastDue ? 'text-amber-600 font-semibold' : 'text-gray-400'}`}>
                                          {done}/{total}회
                                        </span>
                                      </div>
                                      {/* Date info */}
                                      <div className="flex flex-col gap-0.5 w-[120px] shrink-0">
                                        <input
                                          type="date"
                                          value={zone.schedule_start || ''}
                                          onChange={e => handleSetZoneStart(zone.id, e.target.value)}
                                          className="text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
                                        />
                                        {endDate && (
                                          <span className="text-xs text-blue-600">→ {format(endDate, 'yyyy.MM.dd')}</span>
                                        )}
                                        {zone.grade === 'P3' && (
                                          <div className="flex items-center gap-1 flex-wrap mt-0.5">
                                            <span className="text-xs text-gray-400">매월</span>
                                            <select
                                              value={zone.monthly_weekday_rule?.nth ?? ''}
                                              onChange={e => {
                                                const nth = e.target.value ? Number(e.target.value) : null;
                                                handleSetWeekdayRule(zone.id, nth ? { nth, dow: zone.monthly_weekday_rule?.dow ?? 1 } : null);
                                              }}
                                              className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                                            >
                                              <option value="">날짜</option>
                                              <option value="1">1째</option>
                                              <option value="2">2째</option>
                                              <option value="3">3째</option>
                                              <option value="4">4째</option>
                                              <option value="5">마지막</option>
                                            </select>
                                            {zone.monthly_weekday_rule?.nth && (
                                              <>
                                                <span className="text-xs text-gray-400">주</span>
                                                <select
                                                  value={zone.monthly_weekday_rule?.dow ?? 1}
                                                  onChange={e => handleSetWeekdayRule(zone.id, { ...zone.monthly_weekday_rule, dow: Number(e.target.value) })}
                                                  className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                                                >
                                                  {DOW_LABEL.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
                                                </select>
                                              </>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      {/* Sampling points 4-col (label over input) */}
                                      <div className="grid grid-cols-4 gap-x-1.5 gap-y-1 shrink-0">
                                        {[
                                          ['points_surface', '표면균'],
                                          ['points_float', '부유균'],
                                          ['points_fall', '낙하균'],
                                          ['points_particle', '부유입자'],
                                        ].map(([field, label]) => (
                                          <div key={field} className="flex flex-col items-center gap-0.5">
                                            <span className="text-[10px] leading-none text-gray-400">{label}</span>
                                            <input
                                              type="number"
                                              min="0"
                                              max="999"
                                              defaultValue={zone[field] ?? ''}
                                              onBlur={e => handleSetZonePoint(zone.id, field, parseInt(e.target.value) || 0)}
                                              className="w-12 text-xs border border-gray-200 rounded px-0.5 py-0.5 text-center focus:outline-none focus:ring-1 focus:ring-blue-400"
                                              placeholder="0"
                                            />
                                          </div>
                                        ))}
                                      </div>
                                      {/* Phase transition */}
                                      {isPastDue && (
                                        <button
                                          onClick={() => setPhasePrompt({ zoneId: zone.id, zoneName: zone.name, nextGrade: NEXT_GRADE[zone.grade], dateStr: '' })}
                                          className="text-xs bg-amber-500 text-white px-1.5 py-1 rounded-lg hover:bg-amber-600 shrink-0"
                                        >→{NEXT_GRADE[zone.grade]}</button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              <div className="h-1" />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 그룹 관리 탭 ── */}
            {settingsTab === 'groups' && (
              <div className="flex-1 overflow-y-auto">
                {/* New group input */}
                <div className="px-5 py-3 border-b border-gray-100 shrink-0">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="새 일정그룹 이름..."
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newGroupName.trim()) {
                          handleSaveGroup({ name: newGroupName.trim(), zoneIds: [] });
                        }
                      }}
                      className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => { if (newGroupName.trim()) handleSaveGroup({ name: newGroupName.trim(), zoneIds: [] }); }}
                      className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
                    >추가</button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">일정그룹으로 묶인 구역은 시작일이 동기화되고, 주기가 긴 구역의 측정일이 가장 잦은(짧은 주기) 구역 측정일에 맞춰 정렬됩니다.</p>
                </div>
                {groups.length === 0 && (
                  <p className="px-5 py-4 text-sm text-gray-400">그룹이 없습니다. 위에서 새 그룹을 만드세요.</p>
                )}
                {groups.map(group => {
                  const groupZones = zones.filter(z => group.zoneIds.includes(z.id));
                  return (
                    <div key={group.id} className="px-5 py-4 border-b border-gray-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold text-gray-800">{group.name}</span>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleSyncGroup(group.id)}
                            title="시작일 동기화 + 측정주기 정렬 (긴 주기를 짧은 주기 측정일에 맞춤)"
                            className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 font-medium"
                          >동기화/정렬</button>
                          <button
                            onClick={() => handleDeleteGroup(group.id)}
                            className="text-xs px-2 py-1 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"
                          >삭제</button>
                        </div>
                      </div>
                      {/* Zone chips in group */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {groupZones.length === 0 && (
                          <span className="text-xs text-gray-400">구역 없음</span>
                        )}
                        {groupZones.map(z => (
                          <div key={z.id} className="flex items-center gap-1 bg-gray-100 rounded-full pl-2 pr-1 py-0.5">
                            <span className={`text-xs font-bold px-1 py-0.5 rounded ${GRADE_COLORS[z.grade] || 'bg-gray-200 text-gray-600'}`}>{z.grade}</span>
                            <span className="text-xs text-gray-700 max-w-[80px] truncate">{z.name}</span>
                            <button
                              onClick={() => handleSaveGroup({ ...group, zoneIds: group.zoneIds.filter(id => id !== z.id) })}
                              className="text-gray-400 hover:text-red-500 text-xs leading-none px-0.5"
                            >✕</button>
                          </div>
                        ))}
                      </div>
                      {/* Add zone to group */}
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          if (!e.target.value || group.zoneIds.includes(e.target.value)) return;
                          handleSaveGroup({ ...group, zoneIds: [...group.zoneIds, e.target.value] });
                          e.target.value = '';
                        }}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">구역 추가...</option>
                        {['공조','압축공기','질소가스'].map(c => {
                          const opts = zones.filter(z =>
                            z.category === c &&
                            !group.zoneIds.includes(z.id) &&
                            ['P1','P2','P3'].includes(z.grade)
                          );
                          if (!opts.length) return null;
                          return (
                            <optgroup key={c} label={c}>
                              {opts.map(z => (
                                <option key={z.id} value={z.id}>
                                  {z.name}[{z.grade}]{z.schedule_start ? ' ' + z.schedule_start : ''}
                                </option>
                              ))}
                            </optgroup>
                          );
                        })}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── 공휴일 탭 ── */}
            {settingsTab === 'holidays' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                <div className="px-4 py-3 border-b border-gray-100 shrink-0 space-y-2">
                  <div className="flex gap-2 items-start">
                    <input type="date" value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)}
                      className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32 shrink-0" />
                    <input type="text" placeholder="공휴일 이름" value={newHolidayName} onChange={e => setNewHolidayName(e.target.value)}
                      className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <button
                      onClick={async () => {
                        if (!newHolidayDate || !newHolidayName.trim()) return;
                        const repeat = newHolidayRepeat
                          ? (newHolidayRepeatType === 'nth-weekday'
                              ? { type: 'nth-weekday', nth: newHolidayNth, dow: newHolidayDow }
                              : { type: newHolidayRepeatType })
                          : null;
                        const h = { date: newHolidayDate, name: newHolidayName.trim(), repeat };
                        const saved = await upsertHoliday(h);
                        setHolidayDefs(prev => {
                          const idx = prev.findIndex(x => x.date === saved.date);
                          return idx >= 0 ? prev.map((x,i) => i === idx ? saved : x) : [...prev, saved];
                        });
                        setNewHolidayDate(''); setNewHolidayName(''); setNewHolidayRepeat(false);
                      }}
                      className="px-2.5 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 shrink-0"
                    >추가</button>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={newHolidayRepeat} onChange={e => setNewHolidayRepeat(e.target.checked)} className="rounded" />
                    반복
                  </label>
                  {newHolidayRepeat && (
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
                <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                  {holidayDefs.length === 0 && (
                    <p className="px-4 py-4 text-sm text-gray-400">등록된 공휴일이 없습니다.</p>
                  )}
                  {[...holidayDefs].sort((a,b) => a.date.localeCompare(b.date)).map(h => {
                    const repeatLabel = !h.repeat || h.repeat.type === 'none' ? null
                      : h.repeat.type === 'yearly' ? `매년 ${h.date.slice(5)}`
                      : h.repeat.type === 'monthly' ? `매월 ${Number(h.date.slice(8))}일`
                      : `매월 ${['','1번째','2번째','3번째','4번째','마지막'][h.repeat.nth]}${ ['일','월','화','수','목','금','토'][h.repeat.dow]}요일`;
                    return (
                      <div key={h.date} className="flex items-center gap-2 px-4 py-2.5">
                        <span className="text-xs text-gray-500 w-24 shrink-0">{h.date}</span>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-red-600 font-medium">{h.name}</span>
                          {repeatLabel && <span className="ml-1.5 text-[10px] text-blue-500 bg-blue-50 px-1 py-0.5 rounded">{repeatLabel}</span>}
                        </div>
                        <button onClick={async () => {
                          await deleteHoliday(h.date);
                          setHolidayDefs(prev => prev.filter(x => x.date !== h.date));
                        }} className="text-xs text-gray-400 hover:text-red-500 shrink-0">✕</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 측정주기 탭 ── */}
            {settingsTab === 'cycle' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                {/* Category sub-tabs */}
                <div className="flex gap-1.5 px-4 py-2.5 border-b border-gray-100 shrink-0">
                  {CYCLE_CATS.map(cat => (
                    <button
                      key={cat}
                      onClick={() => setCycleCatTab(cat)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        cycleCatTab === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >{cat}</button>
                  ))}
                </div>
                <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
                  <p className="text-xs text-gray-400 leading-snug">등급별 측정 횟수·간격을 설정합니다. 변경 시 달력 일정이 즉시 재계산됩니다.</p>
                  <button
                    onClick={() => resetCycleCategory(cycleCatTab)}
                    className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 shrink-0 ml-2"
                  >기본값</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {CYCLE_GRADES.map(grade => {
                    const phases = scheduleConfig[cycleCatTab]?.[grade] || [];
                    const totalCnt = phases.reduce((s, p) => s + (p.count || 0), 0);
                    return (
                      <div key={grade} className="border border-gray-200 rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-bold px-2 py-0.5 rounded ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                            <span className="text-xs text-gray-400">총 {totalCnt}회</span>
                          </div>
                          <button
                            onClick={() => addCyclePhase(cycleCatTab, grade)}
                            className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 font-medium"
                          >+ 구간</button>
                        </div>
                        <div className="divide-y divide-gray-50">
                          {phases.length === 0 && (
                            <p className="px-3 py-2 text-xs text-gray-400 italic">구간이 없습니다. '+ 구간'으로 추가하세요.</p>
                          )}
                          {phases.map((phase, idx) => {
                            const isMonthlyLike = phase.type === 'monthly' || phase.type === 'quarterly';
                            return (
                              <div key={idx} className="flex items-center gap-1.5 px-3 py-2 flex-wrap">
                                <span className="text-[10px] text-gray-300 w-4 shrink-0">{idx + 1}</span>
                                <select
                                  value={phase.type}
                                  onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'type', e.target.value)}
                                  className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                >
                                  {CYCLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </select>
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number" min="1" max="999"
                                    value={phase.count}
                                    onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'count', e.target.value)}
                                    className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                                  />
                                  <span className="text-xs text-gray-400">회</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  {isMonthlyLike ? (
                                    <span className="text-xs text-gray-400">{phase.type === 'monthly' ? '1개월 간격' : '3개월 간격'}</span>
                                  ) : (
                                    <>
                                      <span className="text-xs text-gray-400">간격</span>
                                      <input
                                        type="number" min="1" max="365"
                                        value={phase.intervalDays ?? ''}
                                        onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'intervalDays', e.target.value)}
                                        className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                      <span className="text-xs text-gray-400">일</span>
                                    </>
                                  )}
                                </div>
                                <button
                                  onClick={() => removeCyclePhase(cycleCatTab, grade, idx)}
                                  className="text-xs text-gray-300 hover:text-red-500 ml-auto shrink-0"
                                  title="구간 삭제"
                                >✕</button>
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
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">달력보기</h1>
          {totalMonthSchedule > 0 && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
              이번달 {totalMonthSchedule}건 측정 예정
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOptimizePopup(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-xl hover:bg-indigo-100 transition-colors"
          >
            ⚖ 일정 최적화
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            ⚙ 일정 설정
          </button>
          <button
            onClick={() => setCalSettingsPopup(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            🗓 달력 설정
          </button>
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-2 py-1">
            <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none">‹</button>
            <span className="text-base font-semibold text-gray-800 min-w-[96px] text-center">{year}년 {MONTH_KR[month - 1]}</span>
            <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-800 transition-colors text-lg leading-none">›</button>
          </div>
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
        <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {dowOrder.map(d => (
              <div key={d} className={`py-2.5 text-center text-xs font-semibold ${
                d === 0 ? 'text-red-500' : d === 6 ? 'text-blue-500' : 'text-gray-500'
              }`}>{DOW_LABELS[d]}</div>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-7">
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

                const catPts = { 공조: {s:0,f:0,l:0,p:0}, 질소가스: 0, 압축공기: 0 };
                schedEvts.forEach(({ zone }) => {
                  const s=zone.points_surface||0, f=zone.points_float||0, l=zone.points_fall||0, p=zone.points_particle||0;
                  if (zone.category === '공조') { catPts['공조'].s+=s; catPts['공조'].f+=f; catPts['공조'].l+=l; catPts['공조'].p+=p; }
                  else if (zone.category === '질소가스') catPts['질소가스'] += s+f+l+p;
                  else if (zone.category === '압축공기') catPts['압축공기'] += s+f+l+p;
                });
                const tempPtsTotal = tempEvts.reduce((t,e)=>t+(e.points_surface||0)+(e.points_float||0)+(e.points_fall||0)+(e.points_particle||0), 0);
                const hasPts = catPts['공조'].s+catPts['공조'].f+catPts['공조'].l+catPts['공조'].p+catPts['질소가스']+catPts['압축공기']+tempPtsTotal > 0;
                const nextCellData = grid[idx + 1];
                const belowCellData = grid[idx + 7];
                const boundaryRight = (isOther && nextCellData && !nextCellData.isOther)
                                   || (!isOther && nextCellData?.isOther);
                const boundaryBottom = (isOther && belowCellData && !belowCellData.isOther)
                                    || (!isOther && belowCellData?.isOther);
                const isHol = !isOther && !!holidays[dateStr];

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
                    className={`min-h-28 p-1.5 cursor-pointer transition-colors
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
                      const ptsChips = hasPts ? (
                        <div className={`flex flex-wrap gap-0.5 ${isOther ? 'opacity-50' : ''}`}>
                          {catPts['공조'].s > 0 && <span className="text-[9px] leading-none bg-green-50 text-green-700 px-0.5 py-0.5 rounded">표{catPts['공조'].s}</span>}
                          {catPts['공조'].f > 0 && <span className="text-[9px] leading-none bg-blue-50 text-blue-700 px-0.5 py-0.5 rounded">부{catPts['공조'].f}</span>}
                          {catPts['공조'].l > 0 && <span className="text-[9px] leading-none bg-orange-50 text-orange-700 px-0.5 py-0.5 rounded">낙{catPts['공조'].l}</span>}
                          {catPts['공조'].p > 0 && <span className="text-[9px] leading-none bg-pink-50 text-pink-700 px-0.5 py-0.5 rounded">입{catPts['공조'].p}</span>}
                          {catPts['질소가스'] > 0 && <span className="text-[9px] leading-none bg-purple-100 text-purple-700 px-0.5 py-0.5 rounded">질{catPts['질소가스']}</span>}
                          {catPts['압축공기'] > 0 && <span className="text-[9px] leading-none bg-yellow-100 text-yellow-700 px-0.5 py-0.5 rounded">압{catPts['압축공기']}</span>}
                          {tempPtsTotal > 0 && <span className="text-[9px] leading-none bg-gray-100 text-gray-500 px-0.5 py-0.5 rounded">임{tempPtsTotal}</span>}
                        </div>
                      ) : null;
                      return isHol ? (
                        <div className="mb-0.5">
                          <div className="flex items-center gap-0.5">
                            <div className={dateNumClass}>{day}</div>
                            <span className="text-[9px] leading-none text-red-500 truncate">{holidays[dateStr]}</span>
                          </div>
                          {ptsChips && <div className="mt-0.5">{ptsChips}</div>}
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-0.5 mb-0.5">
                          <div className={dateNumClass}>{day}</div>
                          {ptsChips}
                        </div>
                      );
                    })()}

                    <div className={`flex flex-col gap-0.5 ${isOther ? 'opacity-50' : ''}`}>
                      {calibEvts.map((c, i) => (
                        <div
                          key={`c${i}`}
                          className={`text-xs px-1 py-0.5 rounded truncate ${dDayColor(c.next_calib_date)}`}
                          title={`${c.name} (${dDayText(c.next_calib_date)})`}
                        >{c.name}</div>
                      ))}
                      {schedEvts.map(({ zone, measurement }, i) => {
                        const bounds = getDragBounds(measurement);
                        const label = `${zone.name}[${zone.grade}]-${measurement.num}`;
                        const isDone = completions.has(`${zone.id}_${measurement.num}`);
                        return (
                          <div
                            key={`s${i}`}
                            draggable={!isDone}
                            onDragStart={isDone ? undefined : (e) => {
                              e.stopPropagation();
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', JSON.stringify({
                                zoneId: zone.id,
                                num: measurement.num,
                                type: measurement.type,
                                minDateStr: format(bounds.min, 'yyyy-MM-dd'),
                                maxDateStr: format(bounds.max, 'yyyy-MM-dd'),
                              }));
                            }}
                            onDragEnd={isDone ? undefined : () => setDragOverDay(null)}
                            onClick={(e) => e.stopPropagation()}
                            className={`text-xs rounded overflow-hidden flex items-stretch min-w-0 ${isDone ? 'opacity-60 cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
                            style={getChipStyle(zone.category, zone.grade)}
                            title={`${label}${isDone ? ' [완료]' : measurement.isFirst ? ' [첫 측정]' : measurement.isLast ? ' [마지막 측정]' : ''}`}
                          >
                            {measurement.isFirst && <span className="w-1 shrink-0" style={{ backgroundColor: '#22c55e' }} />}
                            <span className={`truncate flex-1 px-1 py-0.5 ${isDone ? 'line-through' : ''} ${(measurement.isFirst || measurement.isLast) ? 'font-semibold' : ''}`}>{label}</span>
                            {measurement.isLast && <span className="w-1 shrink-0" style={{ backgroundColor: '#ef4444' }} />}
                          </div>
                        );
                      })}
                      {tempEvts.map((t, i) => (
                        <div
                          key={`t${i}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs px-1 py-0.5 rounded truncate bg-orange-50 border border-orange-200 text-orange-600"
                          title={`${t.name}[임시]`}
                        >{t.name}[임시]</div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />만료됨
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-orange-100 border border-orange-200 inline-block" />7일 이내
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-3 h-3 rounded bg-yellow-50 border border-yellow-200 inline-block" />이번달 교정
            </div>
            {/* Category chips — click to edit colors */}
            {['공조', '질소가스', '압축공기'].map(cat => {
              const c = chipColors[`cat_${cat}`] ?? DEFAULT_CHIP_COLORS[`cat_${cat}`];
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
              <div className={`px-4 py-3 ${hdBg} text-white shrink-0`}>
                <p className={`text-xs ${hdSub}`}>{selectedDay.slice(0,4)}년 {MONTH_KR[parseInt(selectedDay.slice(5,7)) - 1]} · {DOW_LABELS[selDow]}요일</p>
                <p className="text-lg font-bold">{parseInt(selectedDay.slice(8,10))}일 일정</p>
                {isSelHol && (
                  <p className={`text-xs mt-0.5 ${hdSub}`}>🎌 {holidays[selectedDay]}</p>
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

              {selectedScheduleEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100">
                    <span className="text-xs font-semibold text-blue-600">측정 일정 ({selectedScheduleEvents.length}건)</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {selectedScheduleEvents.map(({ zone, measurement }) => {
                      const bounds = getDragBounds(measurement);
                      const compKey = `${zone.id}_${measurement.num}`;
                      const isDone = completions.has(compKey);
                      return (
                        <div
                          key={`${zone.id}-${measurement.num}`}
                          className={`px-4 py-2.5 cursor-pointer select-none ${isDone ? 'bg-green-50/60' : 'hover:bg-gray-50/50'}`}
                          style={{
                            borderLeft: measurement.isFirst ? '3px solid #22c55e' : measurement.isLast ? '3px solid #ef4444' : undefined,
                          }}
                          onDoubleClick={() => setCompletionPrompt({ zoneId: zone.id, zoneName: zone.name, grade: zone.grade, num: measurement.num, dateStr: selectedDay, isCompleted: isDone })}
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
                            <span className="text-xs text-gray-400">#{measurement.num}</span>
                          </div>
                          <p className={`text-sm font-medium break-words ${isDone ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                            {zone.name}[{zone.grade}]
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            측정주기: {format(bounds.min, 'MM/dd')}~{format(bounds.max, 'MM/dd')}
                          </p>
                          {(zone.points_surface || zone.points_float || zone.points_fall || zone.points_particle) ? (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {zone.category === '질소가스' ? (
                                <span className="text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded font-medium">
                                  질소 {(zone.points_surface||0)+(zone.points_float||0)+(zone.points_fall||0)+(zone.points_particle||0)}pt
                                </span>
                              ) : zone.category === '압축공기' ? (
                                <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 py-0.5 rounded font-medium">
                                  압축공기 {(zone.points_surface||0)+(zone.points_float||0)+(zone.points_fall||0)+(zone.points_particle||0)}pt
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

              {selectedTempEvents.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-orange-50 border-b border-orange-100 border-t border-t-gray-100">
                    <span className="text-xs font-semibold text-orange-600">임시 일정 ({selectedTempEvents.length}건)</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {selectedTempEvents.map(t => (
                      <div key={t.id} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-orange-50 border border-orange-200 text-orange-600">임시</span>
                          <button
                            onClick={async () => {
                              await deleteTempSchedule(t.id);
                              setTempSchedules(prev => prev.filter(x => x.id !== t.id));
                            }}
                            className="text-xs text-gray-400 hover:text-red-500 leading-none"
                          >✕</button>
                        </div>
                        <p className="text-sm font-medium text-gray-800">{t.name}</p>
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

              {selectedCalibEvents.length === 0 && selectedScheduleEvents.length === 0 && selectedTempEvents.length === 0 && (
                <p className="px-4 py-3 text-sm text-gray-400">일정 없음</p>
              )}
              </div>
              <div className="px-3 py-2 border-t border-gray-100 shrink-0">
                <button
                  onClick={() => {
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

          {/* Monitoring progress */}
          {zones.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-600">📋 모니터링 현황</p>
                <span className={`text-xs font-bold ${monRate === 100 ? 'text-green-600' : 'text-blue-600'}`}>{monRate}%</span>
              </div>
              <div className="px-4 py-3">
                <div className="w-full bg-gray-100 rounded-full h-2 mb-2 overflow-hidden">
                  <div className={`h-2 rounded-full ${monRate === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${monRate}%` }} />
                </div>
                <p className="text-xs text-gray-500">{completedCount}/{zones.length} 구역 완료</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
