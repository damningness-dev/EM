import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { fetchZones, upsertZone, deleteZone, fetchMonitoringData, upsertMonitoringEntry, fetchCompletions, setCompletion, deleteCompletion, fetchHolidays, fetchGroups, upsertGroup, fetchScheduleConfig, saveScheduleConfig } from '../lib/api';
import { GRADE_TARGETS, GRADE_COLORS, CLEAN_GRADES, CLEAN_GRADE_COLORS } from '../data/initialData';
import { calcMeasurements, calcEndDate, GRADE_PRIORITY, buildHolidayMap, computeCascadeSchedules, DEFAULT_SCHEDULE_SPECS, setScheduleConfig, getScheduleConfig } from '../lib/schedule';
import { format } from 'date-fns';

const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const GRADES = ['P1', 'P2', 'P3', '유지관리', 'OQ', 'PQ'];
const PROGRESSION = ['P1', 'P2', 'P3', '유지관리'];
const CYCLE_TYPES = [
  { value: 'daily',     label: '매일(일1회)' },
  { value: 'weekly',    label: '주1회' },
  { value: 'biweekly',  label: '격주(2주)' },
  { value: 'monthly',   label: '월1회' },
  { value: 'quarterly', label: '분기1회(3개월)' },
];
const DEFAULT_INTERVAL = { daily: 1, weekly: 7, biweekly: 14 };
const CYCLE_GRADES = ['P1', 'P2', 'P3', '유지관리'];
const CATEGORY_BG = { '질소가스': '#faf5ff', '압축공기': '#fffbeb' };
// 질소가스·압축공기는 부유균/낙하균/표면균/부유입자를 구분하지 않고 통합 측정값 하나로 관리한다.
// 통합값은 airborne(→points_float) 한 곳에만 저장한다.
const COMBINED_CATS = ['질소가스', '압축공기'];

export default function MonthlyMonitoring({ year, onYearChange }) {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [zones, setZones] = useState([]);
  const [monData, setMonData] = useState({});
  const [completions, setCompletions] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [namedGroups, setNamedGroups] = useState([]);
  const [groupBy, setGroupBy] = useState(false);
  const [newGroupModal, setNewGroupModal] = useState(null); // { zoneGroup }
  const [newGroupName, setNewGroupName] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [holidayDefs, setHolidayDefs] = useState([]);
  const [showAddZone, setShowAddZone] = useState(false);
  const [zoneForm, setZoneForm] = useState({});
  const [editEntry, setEditEntry] = useState(null);
  const [entryForm, setEntryForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { id, name }
  const [errorMsg, setErrorMsg] = useState(null);
  // 순서/그룹 관리 팝업
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [modalGroups, setModalGroups] = useState([]);
  const [modalSelectedIdx, setModalSelectedIdx] = useState(null);
  const [modalNamedGroups, setModalNamedGroups] = useState([]);
  const [modalPos, setModalPos] = useState({ x: 60, y: 40 });
  const [modalSize, setModalSize] = useState({ w: 840, h: 560 });
  const [modalSaving, setModalSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [modalNewFolderName, setModalNewFolderName] = useState('');
  const [showModalNewFolder, setShowModalNewFolder] = useState(false);
  const modalDragOffset = useRef(null);
  const modalListRef = useRef(null);
  const resizeDragRef = useRef(null);
  // 측정주기 설정 모달
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [cycleConfig, setCycleConfig] = useState(() => getScheduleConfig());
  const [cycleCatTab, setCycleCatTab] = useState(() => Object.keys(getScheduleConfig())[0] || '공조');
  const [newCatName, setNewCatName] = useState('');

  useEffect(() => {
    Promise.all([fetchZones(), fetchCompletions(), fetchHolidays(), fetchGroups()]).then(([zns, comps, hols, grps]) => {
      // 레거시 '청정등급' 분류 → '공조'로 이관 (청정등급은 이제 각 일정의 속성)
      const legacy = zns.filter(z => z.category === '청정등급');
      if (legacy.length) {
        legacy.forEach(z => upsertZone({ ...z, category: '공조' }));
        zns = zns.map(z => z.category === '청정등급' ? { ...z, category: '공조' } : z);
      }
      setZones(zns);
      setCompletions(new Set(comps.map(c => `${c.zoneId}_${c.num}`)));
      setHolidayDefs(hols);
      setNamedGroups(grps);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchMonitoringData(year, month).then(d => { setMonData(d); setLoading(false); });
  }, [year, month]);

  // 모달 목록에서 선택된 행 자동 스크롤
  useEffect(() => {
    if (modalSelectedIdx === null || !modalListRef.current) return;
    const row = modalListRef.current.querySelector(`[data-modal-row="${modalSelectedIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [modalSelectedIdx]);

  // 측정주기 설정 — 앱 로드 후 모듈 변수와 동기화
  useEffect(() => {
    fetchScheduleConfig().then(cfg => {
      if (cfg) {
        setScheduleConfig(cfg);
        setCycleConfig(cfg);
        setCycleCatTab(Object.keys(cfg)[0] || '공조');
      }
    }).catch(() => {});
  }, []);

  // 분류 목록 = 측정주기 설정 키 (동적)
  const categories = useMemo(() => Object.keys(cycleConfig), [cycleConfig]);

  // Group all zones by name+category; one P1/P2/P3/유지관리 per group
  const zoneGroups = useMemo(() => {
    const map = {};
    zones.forEach(zone => {
      const key = `${zone.category}|||${zone.name}`;
      if (!map[key]) map[key] = { name: zone.name, category: zone.category, key, zones: [] };
      map[key].zones.push(zone);
    });
    Object.values(map).forEach(g => {
      g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
    });
    return map;
  }, [zones]);

  // Schedule-based stats per zone for this month (linked to CalendarView completions)
  const scheduleThisMonth = useMemo(() => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const result = {};
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const ms = calcMeasurements(zone);
      const thisMonthMs = ms.filter(m => format(m.date, 'yyyy-MM') === monthStr);
      if (thisMonthMs.length) {
        result[zone.id] = {
          total: thisMonthMs.length,
          done: thisMonthMs.filter(m => completions.has(`${zone.id}_${m.num}`)).length,
        };
      }
    });
    return result;
  }, [zones, year, month, completions]);

  // Which zones are currently within their schedule window
  const activeZoneIds = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = new Set();
    zones.forEach(zone => {
      if (!zone.schedule_start) return;
      const start = new Date(zone.schedule_start + 'T00:00:00');
      const end = calcEndDate(zone);
      if (!end) return;
      if (today >= start && today <= end) active.add(zone.id);
    });
    return active;
  }, [zones]);

  // 구역 그룹 정렬 키 = 그룹 내 zone들의 최소 sort_order
  function groupOrderKey(g) {
    return Math.min(...g.zones.map(z => (typeof z.sort_order === 'number' ? z.sort_order : 1e9)));
  }

  const orderedAllGroups = useMemo(() => {
    const arr = Object.values(zoneGroups);
    arr.sort((a, b) => (groupOrderKey(a) - groupOrderKey(b)) || a.name.localeCompare(b.name));
    return arr;
  }, [zoneGroups]);

  const filteredGroups = useMemo(() => {
    let groups = orderedAllGroups;
    if (categoryFilter !== 'all') groups = groups.filter(g => g.category === categoryFilter);
    if (search) groups = groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
    if (gradeFilter !== 'all') groups = groups.filter(g => g.zones.some(z => z.grade === gradeFilter && activeZoneIds.has(z.id)));
    return groups;
  }, [orderedAllGroups, search, gradeFilter, categoryFilter, activeZoneIds]);

  // 구역을 소속 그룹명으로 묶기 (그룹으로 보기 ON)
  function groupOf(zoneGroup) {
    const ids = zoneGroup.zones.map(z => z.id);
    return namedGroups.find(g => (g.zoneIds || []).some(id => ids.includes(id))) || null;
  }

  const groupedSections = useMemo(() => {
    const map = new Map();
    filteredGroups.forEach(zg => {
      const g = groupOf(zg);
      const key = g ? g.id : '__none__';
      if (!map.has(key)) map.set(key, { id: key, name: g ? g.name : '그룹 미지정', items: [] });
      map.get(key).items.push(zg);
    });
    const sections = [...map.values()];
    // '그룹 미지정'은 항상 마지막
    sections.sort((a, b) => (a.id === '__none__' ? 1 : 0) - (b.id === '__none__' ? 1 : 0));
    return sections;
  }, [filteredGroups, namedGroups]);

  const progress = useMemo(() => {
    let total = 0, done = 0;
    filteredGroups.forEach(group => {
      group.zones.forEach(zone => {
        const sched = scheduleThisMonth[zone.id];
        if (sched) {
          total += sched.total; done += sched.done;
        } else {
          const target = GRADE_TARGETS[zone.grade] || 1;
          total += target;
          const e = monData[zone.id];
          if (e) done += Math.min(e.count || 0, target);
        }
      });
    });
    return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [filteredGroups, monData, scheduleThisMonth]);

  function getEntry(zoneId) {
    return monData[zoneId] || { airborne:'', settle:'', surface:'', particle:'', count:0, note:'', start_date:'', done:false };
  }

  // 스케줄이 있는 구역은 달력 완료 수(completions)를 count 초기값으로 사용
  // 측정포인트 수는 달력(zone.points_*)과 동기화 — 구역 값이 있으면 우선 사용
  function openEntryModal(zone) {
    const entry = getEntry(zone.id);
    const sched = scheduleThisMonth[zone.id];
    const pt = (zv, ev) => (zv != null && zv !== 0 ? String(zv) : (ev ?? ''));
    setEntryForm({
      ...entry,
      count: sched ? sched.done : (entry.count || 0),
      airborne: pt(zone.points_float, entry.airborne),
      settle: pt(zone.points_fall, entry.settle),
      surface: pt(zone.points_surface, entry.surface),
      particle: pt(zone.points_particle, entry.particle),
    });
    setEditEntry(zone);
  }

  function getActiveZone(group) {
    return group.zones.find(z => activeZoneIds.has(z.id)) || group.zones[0];
  }

  function toggleGroup(key) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ─── 순서/그룹 관리 팝업 ──────────────────────────────────────────────────────

  function openOrderModal() {
    setModalGroups(orderedAllGroups.map(g => ({ ...g, zones: [...g.zones] })));
    setModalNamedGroups(namedGroups.map(g => ({ ...g, zoneIds: [...(g.zoneIds || [])] })));
    setModalSelectedIdx(null);
    setShowOrderModal(true);
  }

  function moveModalSelected(dir) {
    if (modalSelectedIdx === null) return;
    const arr = [...modalGroups];
    let newIdx;
    if (dir === 'top')    newIdx = 0;
    else if (dir === 'up10')   newIdx = Math.max(0, modalSelectedIdx - 10);
    else if (dir === 'up1')    newIdx = Math.max(0, modalSelectedIdx - 1);
    else if (dir === 'down1')  newIdx = Math.min(arr.length - 1, modalSelectedIdx + 1);
    else if (dir === 'down10') newIdx = Math.min(arr.length - 1, modalSelectedIdx + 10);
    else if (dir === 'bottom') newIdx = arr.length - 1;
    else return;
    if (newIdx === modalSelectedIdx) return;
    const [item] = arr.splice(modalSelectedIdx, 1);
    arr.splice(newIdx, 0, item);
    setModalGroups(arr);
    setModalSelectedIdx(newIdx);
  }

  function handleModalDrop(e, targetIdx) {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData('modalDragIdx');
    if (!fromStr) return;
    const fromIdx = parseInt(fromStr);
    if (!isNaN(fromIdx) && fromIdx !== targetIdx) {
      const arr = [...modalGroups];
      const [item] = arr.splice(fromIdx, 1);
      arr.splice(targetIdx, 0, item);
      setModalGroups(arr);
      setModalSelectedIdx(targetIdx);
    }
    setDragIdx(null); setDropIdx(null);
  }

  function handleFolderDrop(e, namedGroupId) {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData('modalDragIdx');
    if (!fromStr) return;
    const fromIdx = parseInt(fromStr);
    if (!isNaN(fromIdx)) modalAssignGroup(fromIdx, namedGroupId || '');
    setDragIdx(null); setDragOverFolder(null);
  }

  async function addModalNewFolder() {
    const name = modalNewFolderName.trim();
    if (!name) return;
    const saved = await upsertGroup({ name, zoneIds: [] });
    setModalNamedGroups(prev => [...prev, saved]);
    setModalNewFolderName('');
    setShowModalNewFolder(false);
  }

  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = modalSize.w, startH = modalSize.h;
    const onMove = ev => setModalSize({ w: Math.max(580, startW + ev.clientX - startX), h: Math.max(320, startH + ev.clientY - startY) });
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function modalGroupOf(zoneGroup) {
    const ids = zoneGroup.zones.map(z => z.id);
    return modalNamedGroups.find(g => (g.zoneIds || []).some(id => ids.includes(id))) || null;
  }

  function modalAssignGroup(idx, namedGroupId) {
    const ids = modalGroups[idx].zones.map(z => z.id);
    setModalNamedGroups(prev => prev.map(g => {
      const has = (g.zoneIds || []).some(id => ids.includes(id));
      const shouldHave = String(g.id) === String(namedGroupId);
      if (has && !shouldHave) return { ...g, zoneIds: g.zoneIds.filter(id => !ids.includes(id)) };
      if (!has && shouldHave) return { ...g, zoneIds: [...new Set([...(g.zoneIds || []), ...ids])] };
      return g;
    }));
  }

  async function saveOrderModal() {
    setModalSaving(true);
    try {
      const zoneUpdates = [];
      modalGroups.forEach((g, gi) => {
        g.zones.forEach((z, zi) => {
          zoneUpdates.push({ ...z, sort_order: gi * 1000 + zi });
        });
      });
      for (const u of zoneUpdates) await upsertZone(u);
      setZones(prev => prev.map(z => zoneUpdates.find(u => u.id === z.id) || z));
      for (const g of modalNamedGroups) await upsertGroup(g);
      setNamedGroups(modalNamedGroups);
      setShowOrderModal(false);
    } catch (e) {
      setErrorMsg('저장 실패: ' + e.message);
    }
    setModalSaving(false);
  }

  function startModalDrag(e) {
    if (e.button !== 0) return;
    modalDragOffset.current = { x: e.clientX - modalPos.x, y: e.clientY - modalPos.y };
    const onMove = ev => {
      if (!modalDragOffset.current) return;
      setModalPos({ x: ev.clientX - modalDragOffset.current.x, y: ev.clientY - modalDragOffset.current.y });
    };
    const onUp = () => {
      modalDragOffset.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  // ─── 측정주기 설정 ──────────────────────────────────────────────────────────────

  function applyCycleConfig(nextCfg) {
    setScheduleConfig(nextCfg);
    setCycleConfig(nextCfg);
    saveScheduleConfig(nextCfg);
  }

  function editCyclePhase(cat, grade, idx, field, value) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    if (!next[cat]?.[grade]?.[idx]) return;
    const phase = next[cat][grade][idx];
    if (field === 'type') {
      phase.type = value;
      if (value === 'monthly' || value === 'quarterly') phase.intervalDays = null;
      else if (phase.intervalDays == null) phase.intervalDays = DEFAULT_INTERVAL[value] ?? 7;
    } else if (field === 'count') {
      phase.count = Math.max(1, parseInt(value) || 1);
    } else if (field === 'intervalDays') {
      phase.intervalDays = Math.max(1, parseInt(value) || 1);
    }
    applyCycleConfig(next);
  }

  function addCyclePhase(cat, grade) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    if (!next[cat]) next[cat] = {};
    if (!next[cat][grade]) next[cat][grade] = [];
    next[cat][grade].push({ count: 1, intervalDays: 14, type: 'biweekly' });
    applyCycleConfig(next);
  }

  function removeCyclePhase(cat, grade, idx) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    next[cat][grade].splice(idx, 1);
    applyCycleConfig(next);
  }

  function resetCycleCategory(cat) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    if (DEFAULT_SCHEDULE_SPECS[cat]) {
      next[cat] = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_SPECS[cat]));
    } else {
      next[cat] = {}; CYCLE_GRADES.forEach(g => { next[cat][g] = []; });
    }
    applyCycleConfig(next);
  }

  function addCycleCategory() {
    const name = newCatName.trim();
    if (!name || cycleConfig[name]) return;
    const next = JSON.parse(JSON.stringify(cycleConfig));
    next[name] = {}; CYCLE_GRADES.forEach(g => { next[name][g] = []; });
    applyCycleConfig(next);
    setCycleCatTab(name);
    setNewCatName('');
  }

  function removeCycleCategory(cat) {
    if (['공조', '압축공기', '질소가스'].includes(cat)) return;
    const next = JSON.parse(JSON.stringify(cycleConfig));
    delete next[cat];
    applyCycleConfig(next);
    setCycleCatTab(Object.keys(next)[0] || '공조');
  }

  // Called on onChange — saves the date immediately without resetting overrides or running cascade,
  // so the native date picker isn't interrupted by cascade-triggered re-renders.
  async function handleZoneStartChange(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, schedule_start: dateStr || null };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));
  }

  // Called on onBlur — resets overrides and runs cascade after the user finishes picking.
  async function handleZoneStart(zoneId, dateStr) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const updated = { ...zone, schedule_start: dateStr || null, schedule_overrides: {} };
    await upsertZone(updated);
    setZones(prev => prev.map(z => z.id === zoneId ? updated : z));

    if (dateStr && ['P1', 'P2', 'P3'].includes(updated.grade)) {
      const startYear = new Date(dateStr).getFullYear();
      const holidayMap = buildHolidayMap(holidayDefs, startYear, startYear + 4);
      const cascadeItems = computeCascadeSchedules(updated, zones, holidayMap);
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
      }
    }
  }

  async function addGradeToGroup(group, grade) {
    if (group.zones.some(z => z.grade === grade)) return;
    try {
      const cleanGrade = group.zones.find(z => z.clean_grade)?.clean_grade || null;
      // Inherit the group's max sort_order so the new zone stays within the group's position
      // (groupOrderKey uses min; assigning sort_order: zones.length could be lower than
      // existing sort_orders set by moveGroup and would pull the group to the top)
      const groupMaxOrder = Math.max(...group.zones.map(z => typeof z.sort_order === 'number' ? z.sort_order : 0));
      const saved = await upsertZone({ name: group.name, category: group.category, grade, clean_grade: cleanGrade, sort_order: groupMaxOrder + 1, schedule_overrides: {} });
      setZones(prev => [...prev, saved]);
    } catch (e) { setErrorMsg('추가 실패: ' + e.message); }
  }

  async function handleDeleteConfirmed() {
    const ids = deleteConfirm.ids;
    for (const id of ids) await deleteZone(id);
    setZones(p => p.filter(z => !ids.includes(z.id)));
    setDeleteConfirm(null);
  }

  async function handleChangeGroupCategory(group, newCategory) {
    if (!newCategory || newCategory === group.category) return;
    // Block if a group with the same name already exists under the target category
    const targetKey = `${newCategory}|||${group.name}`;
    if (zoneGroups[targetKey]) {
      setErrorMsg(`동일한 구역명이 존재합니다 "${group.name}"`);
      return;
    }
    const updates = await Promise.all(group.zones.map(z => {
      const u = { ...z, category: newCategory };
      return upsertZone(u).then(() => u);
    }));
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
  }

  // 구역 순서 조정 — 보이는 목록에서 인접 그룹과 위치 교환 (sort_order 재기록)
  async function moveGroup(group, dir) {
    const list = filteredGroups;
    const idx = list.findIndex(g => g.key === group.key);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= list.length) return;
    const other = list[swapIdx];
    const full = [...orderedAllGroups];
    const a = full.findIndex(g => g.key === group.key);
    const b = full.findIndex(g => g.key === other.key);
    if (a < 0 || b < 0) return;
    [full[a], full[b]] = [full[b], full[a]];
    // 전체 그룹 순서대로 sort_order 재기록
    const updates = [];
    full.forEach((g, gi) => {
      g.zones.forEach((z, zi) => {
        const newOrder = gi * 1000 + zi;
        if (z.sort_order !== newOrder) updates.push({ ...z, sort_order: newOrder });
      });
    });
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
    for (const u of updates) await upsertZone(u);
  }

  // 구역을 명명된 그룹에 배정 (다른 그룹에서는 제거)
  async function assignGroup(zoneGroup, value) {
    if (value === '__new__') { setNewGroupName(''); setNewGroupModal({ zoneGroup }); return; }
    const ids = zoneGroup.zones.map(z => z.id);
    const targetId = value || null;
    const changed = [];
    for (const g of namedGroups) {
      const has = (g.zoneIds || []).some(id => ids.includes(id));
      const shouldHave = String(g.id) === String(targetId);
      if (has && !shouldHave) changed.push({ ...g, zoneIds: g.zoneIds.filter(id => !ids.includes(id)) });
      else if (!has && shouldHave) changed.push({ ...g, zoneIds: [...new Set([...(g.zoneIds || []), ...ids])] });
    }
    for (const g of changed) await upsertGroup(g);
    setNamedGroups(prev => prev.map(g => changed.find(c => c.id === g.id) || g));
  }

  async function createGroupAndAssign() {
    const name = newGroupName.trim();
    if (!name || !newGroupModal) return;
    const ids = newGroupModal.zoneGroup.zones.map(z => z.id);
    // 다른 그룹에서 제거
    const removed = [];
    for (const g of namedGroups) {
      if ((g.zoneIds || []).some(id => ids.includes(id))) {
        removed.push({ ...g, zoneIds: g.zoneIds.filter(id => !ids.includes(id)) });
      }
    }
    for (const g of removed) await upsertGroup(g);
    const saved = await upsertGroup({ name, zoneIds: ids });
    setNamedGroups(prev => [...prev.map(g => removed.find(r => r.id === g.id) || g), saved]);
    setNewGroupModal(null);
    setNewGroupName('');
  }

  // 청정등급 부여 — 그룹 전체 또는 단일 일정(zone)에 적용
  async function handleSetCleanGrade(zoneIds, value) {
    const ids = Array.isArray(zoneIds) ? zoneIds : [zoneIds];
    const cleanGrade = value || null;
    const updates = await Promise.all(zones.filter(z => ids.includes(z.id)).map(z => {
      const u = { ...z, clean_grade: cleanGrade };
      return upsertZone(u).then(() => u);
    }));
    setZones(prev => prev.map(z => updates.find(u => u.id === z.id) || z));
  }

  async function saveEntry() {
    setSaving(true);
    const countVal = parseInt(entryForm.count) || 0;
    const combined = COMBINED_CATS.includes(editEntry.category);
    const payload = {
      zone_id: editEntry.id, year, month,
      airborne: entryForm.airborne || null,
      settle:   combined ? null : (entryForm.settle || null),
      surface:  combined ? null : (entryForm.surface || null),
      particle: combined ? null : (entryForm.particle || null),
      count: countVal, note: entryForm.note || null,
      start_date: entryForm.start_date || null, done: entryForm.done || false,
      ...(entryForm.id ? { id: entryForm.id } : {}),
    };
    try {
      const saved = await upsertMonitoringEntry(payload);
      setMonData(p => ({ ...p, [editEntry.id]: saved }));

      // 측정포인트 수를 달력(zone.points_*)과 동기화
      const num = v => parseInt(v) || 0;
      const ptUpdate = {
        points_float: num(entryForm.airborne),
        points_fall: combined ? 0 : num(entryForm.settle),
        points_surface: combined ? 0 : num(entryForm.surface),
        points_particle: combined ? 0 : num(entryForm.particle),
      };
      const curZone = zones.find(z => z.id === editEntry.id) || editEntry;
      const changed = ['points_float','points_fall','points_surface','points_particle']
        .some(k => (curZone[k] || 0) !== ptUpdate[k]);
      if (changed) {
        const updatedZone = { ...curZone, ...ptUpdate };
        await upsertZone(updatedZone);
        setZones(prev => prev.map(z => z.id === updatedZone.id ? updatedZone : z));
      }

      // 달력(completions)과 동기화 — schedule_start가 있는 구역에만 적용
      if (editEntry.schedule_start) {
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const ms = calcMeasurements(editEntry).filter(m => format(m.date, 'yyyy-MM') === monthStr);
        const target = Math.min(countVal, ms.length);
        const next = new Set(completions);
        for (let i = 0; i < ms.length; i++) {
          const key = `${editEntry.id}_${ms[i].num}`;
          if (i < target) {
            if (!next.has(key)) { await setCompletion(editEntry.id, ms[i].num); next.add(key); }
          } else {
            if (next.has(key)) { await deleteCompletion(editEntry.id, ms[i].num); next.delete(key); }
          }
        }
        setCompletions(next);
      }

      setEditEntry(null);
    } catch (e) { setErrorMsg('저장 실패: ' + e.message); }
    setSaving(false);
  }

  async function handleAddZone() {
    if (!zoneForm.name || !zoneForm.grade) return;
    const groupKey = `${zoneForm.category || '공조'}|||${zoneForm.name}`;
    const existing = zoneGroups[groupKey];
    if (existing && PROGRESSION.includes(zoneForm.grade) && existing.zones.some(z => z.grade === zoneForm.grade)) {
      setErrorMsg(`동일한 구역명이 존재합니다 "${zoneForm.name}"`);
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertZone({ name: zoneForm.name, grade: zoneForm.grade, category: zoneForm.category || '공조', clean_grade: zoneForm.clean_grade || null, sort_order: zones.length, schedule_overrides: {} });
      setZones(p => [...p, saved]);
      setShowAddZone(false);
      setZoneForm({});
    } catch (e) { setErrorMsg('추가 실패: ' + e.message); }
    setSaving(false);
  }

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">월별 환경 모니터링</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1">
            <button onClick={() => onYearChange(year - 1)} className="px-2 py-1.5 border rounded-l-lg text-sm hover:bg-gray-50">◀</button>
            <span className="px-4 py-1.5 border-y text-sm font-semibold">{year}년</span>
            <button onClick={() => onYearChange(year + 1)} className="px-2 py-1.5 border rounded-r-lg text-sm hover:bg-gray-50">▶</button>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {MONTHS.map((m, i) => (
              <button key={i} onClick={() => setMonth(i + 1)} className={`px-3 py-1.5 text-sm transition-colors ${month === i + 1 ? 'bg-blue-600 text-white' : 'hover:bg-gray-50 text-gray-600'}`}>{i + 1}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-600">{year}년 {month}월 진행률</span>
          <span className="text-sm font-bold text-blue-600">{progress.pct}% ({progress.done}/{progress.total})</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input type="text" placeholder="구역명 검색..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 min-w-48 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
        {/* 분류 필터 */}
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setCategoryFilter('all')} className={`px-3 py-1.5 rounded-lg text-sm border ${categoryFilter === 'all' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>전체분류</button>
          {categories.map(c => (
            <button key={c} onClick={() => setCategoryFilter(c)} className={`px-3 py-1.5 rounded-lg text-sm border ${categoryFilter === c ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{c}</button>
          ))}
        </div>
        {/* 등급 필터 */}
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setGradeFilter('all')} className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === 'all' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>전체등급</button>
          {GRADES.map(g => (
            <button key={g} onClick={() => setGradeFilter(g)} className={`px-3 py-1.5 rounded-lg text-sm border ${gradeFilter === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{g}</button>
          ))}
        </div>
        <button
          onClick={() => setGroupBy(v => !v)}
          className={`px-3 py-1.5 rounded-lg text-sm border font-medium ${groupBy ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        >📁 그룹으로 보기</button>
        <button onClick={openOrderModal} className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-100 font-medium">🗂 순서/그룹 관리</button>
        <button onClick={() => setShowCycleModal(true)} className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-100 font-medium">⚙ 측정주기 설정</button>
        <button onClick={() => { setShowAddZone(true); setZoneForm({}); }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 ml-auto">+ 구역 추가</button>
      </div>

      {/* Table */}
      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="w-16 px-2 py-3 text-center text-gray-400 font-medium text-xs">순서</th>
                  <th className="text-left px-3 py-3 text-gray-500 font-medium">구역명</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">분류</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">그룹</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">청정등급</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">활성등급</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">이번달</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">낙하균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">표면균</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">부유입자</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">상태</th>
                  <th className="text-center px-3 py-3 text-gray-500 font-medium">관리</th>
                </tr>
              </thead>
              <tbody>
                {(groupBy
                  ? groupedSections.flatMap(sec => [{ kind: 'section', sec }, ...sec.items.map(g => ({ kind: 'group', group: g }))])
                  : filteredGroups.map(g => ({ kind: 'group', group: g }))
                ).map((row) => {
                  if (row.kind === 'section') {
                    return (
                      <tr key={`sec-${row.sec.id}`} className="bg-purple-50/70 border-y border-purple-100">
                        <td colSpan={13} className="px-4 py-2">
                          <span className="text-sm font-bold text-purple-700">📁 {row.sec.name}</span>
                          <span className="ml-2 text-xs text-purple-400">({row.sec.items.length}개 구역)</span>
                        </td>
                      </tr>
                    );
                  }
                  const group = row.group;
                  const idx = filteredGroups.findIndex(g => g.key === group.key);
                  const isExpanded = expandedGroups.has(group.key);
                  const activeZone = getActiveZone(group);
                  const isGroupActive = group.zones.some(z => activeZoneIds.has(z.id));
                  const sched = activeZone ? scheduleThisMonth[activeZone.id] : null;
                  const entry = activeZone ? getEntry(activeZone.id) : null;
                  const countTarget = sched ? sched.total : (GRADE_TARGETS[activeZone?.grade] || 1);
                  const countNum = sched ? sched.done : (parseInt(entry?.count) || 0);
                  const isComplete = countNum >= countTarget && countTarget > 0;
                  const gradeMap = {};
                  group.zones.forEach(z => { gradeMap[z.grade] = z; });

                  return (
                    <Fragment key={group.key}>
                      {/* Group summary row */}
                      <tr
                        className={`border-b border-gray-100 cursor-pointer select-none transition-colors ${isExpanded ? 'border-blue-100' : ''}`}
                        style={{ backgroundColor: isExpanded ? 'rgba(219,234,254,0.35)' : isGroupActive ? 'rgba(219,234,254,0.15)' : CATEGORY_BG[group.category] }}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <td className="px-2 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            {!groupBy && (
                              <div className="flex flex-col leading-none">
                                <button onClick={() => moveGroup(group, 'up')} disabled={idx <= 0}
                                  className="text-[10px] text-gray-400 hover:text-blue-600 disabled:opacity-20 disabled:cursor-default" title="위로">▲</button>
                                <button onClick={() => moveGroup(group, 'down')} disabled={idx >= filteredGroups.length - 1}
                                  className="text-[10px] text-gray-400 hover:text-blue-600 disabled:opacity-20 disabled:cursor-default" title="아래로">▼</button>
                              </div>
                            )}
                            <span className="text-gray-400 text-xs font-bold cursor-pointer" onClick={() => toggleGroup(group.key)}>{isExpanded ? '▼' : '▶'}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-gray-800">{group.name}</span>
                            {isGroupActive && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-medium">진행중</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <select
                            value={group.category}
                            onChange={e => handleChangeGroupCategory(group, e.target.value)}
                            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <select
                            value={groupOf(group)?.id || ''}
                            onChange={e => assignGroup(group, e.target.value)}
                            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500 max-w-[120px]"
                          >
                            <option value="">그룹 없음</option>
                            {namedGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            <option value="__new__">+ 새 그룹...</option>
                          </select>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <select
                            value={activeZone?.clean_grade || ''}
                            onChange={e => handleSetCleanGrade(group.zones.map(z => z.id), e.target.value)}
                            className={`text-xs border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 font-semibold ${activeZone?.clean_grade ? (CLEAN_GRADE_COLORS[activeZone.clean_grade] || 'bg-white text-gray-600') + ' border-transparent' : 'bg-white text-gray-400 border-gray-200'}`}
                          >
                            <option value="">-</option>
                            {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {activeZone && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${GRADE_COLORS[activeZone.grade] || 'bg-gray-100 text-gray-600'}`}>
                              {activeZone.grade}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-center">
                          {countTarget > 0 ? (
                            <div className="flex flex-col items-center">
                              <span className={`font-semibold text-xs ${isComplete ? 'text-green-600' : 'text-gray-700'}`}>{countNum}/{countTarget}</span>
                              {sched && <span className="text-[9px] text-blue-500 mt-0.5">달력연동</span>}
                            </div>
                          ) : <span className="text-gray-300 text-xs">-</span>}
                        </td>
                        {COMBINED_CATS.includes(group.category) ? (
                          <td colSpan={4} className="px-3 py-3 text-center text-xs text-gray-500">
                            {(activeZone?.points_float || entry?.airborne)
                              ? <><span className="text-[10px] text-gray-400 mr-1">통합</span>{activeZone?.points_float || entry?.airborne}</>
                              : <span className="text-[10px] text-gray-300">통합 -</span>}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-3 text-center text-xs text-gray-500">{activeZone?.points_float || entry?.airborne || '-'}</td>
                            <td className="px-3 py-3 text-center text-xs text-gray-500">{activeZone?.points_fall || entry?.settle || '-'}</td>
                            <td className="px-3 py-3 text-center text-xs text-gray-500">{activeZone?.points_surface || entry?.surface || '-'}</td>
                            <td className="px-3 py-3 text-center text-xs text-gray-500">{activeZone?.points_particle || entry?.particle || '-'}</td>
                          </>
                        )}
                        <td className="px-3 py-3 text-center">
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                            isComplete ? 'bg-green-100 text-green-700' :
                            countNum > 0 ? 'bg-blue-100 text-blue-700' :
                            isGroupActive ? 'bg-orange-100 text-orange-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>
                            {isComplete ? '완료' : countNum > 0 ? '진행중' : isGroupActive ? '예정' : '미시작'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            {activeZone && (
                              <button
                                onClick={() => openEntryModal(activeZone)}
                                className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                              >수정</button>
                            )}
                            <button
                              onClick={() => setDeleteConfirm({ ids: group.zones.map(z => z.id), name: group.name })}
                              className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded"
                            >삭제</button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded grade progression */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={13} className="p-0">
                            <div className="bg-gray-50 border-b-2 border-blue-100 px-6 py-3 space-y-2">
                              {PROGRESSION.map(grade => {
                                const zone = gradeMap[grade];
                                if (zone) {
                                  const ms = calcMeasurements(zone);
                                  const endDate = calcEndDate(zone);
                                  const isActive = activeZoneIds.has(zone.id);
                                  const zoneSched = scheduleThisMonth[zone.id];
                                  const totalMs = ms.length;
                                  const completedMs = ms.filter(m => completions.has(`${zone.id}_${m.num}`)).length;
                                  const pct = totalMs > 0 ? Math.round((completedMs / totalMs) * 100) : 0;
                                  return (
                                    <div key={grade} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 border ${isActive ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-100'}`}>
                                      <span className={`text-xs font-bold px-2 py-1 rounded shrink-0 ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                                      {isActive && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-medium shrink-0">진행중</span>}
                                      <select
                                        value={zone.clean_grade || ''}
                                        onChange={e => handleSetCleanGrade(zone.id, e.target.value)}
                                        onClick={e => e.stopPropagation()}
                                        title="청정등급"
                                        className={`text-[10px] border rounded px-1 py-0.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-blue-500 font-semibold ${zone.clean_grade ? (CLEAN_GRADE_COLORS[zone.clean_grade] || 'bg-white text-gray-600') + ' border-transparent' : 'bg-white text-gray-400 border-gray-200'}`}
                                      >
                                        <option value="">청정-</option>
                                        {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}등급</option>)}
                                      </select>
                                      <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
                                        <span className="text-xs text-gray-400 shrink-0">시작일</span>
                                        <input
                                          type="date"
                                          value={zone.schedule_start || ''}
                                          onChange={e => handleZoneStartChange(zone.id, e.target.value)}
                                          onBlur={e => handleZoneStart(zone.id, e.target.value)}
                                          onClick={e => e.stopPropagation()}
                                          className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32 shrink-0"
                                        />
                                        {endDate && (
                                          <span className="text-xs text-blue-600 shrink-0">→ {format(endDate, 'yyyy.MM.dd')}</span>
                                        )}
                                        {totalMs > 0 && (
                                          <div className="flex items-center gap-1.5 shrink-0">
                                            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                              <div className={`h-full rounded-full ${completedMs >= totalMs ? 'bg-green-500' : 'bg-blue-400'}`} style={{ width: `${pct}%` }} />
                                            </div>
                                            <span className="text-[10px] text-gray-400">{completedMs}/{totalMs}</span>
                                          </div>
                                        )}
                                        {zoneSched && (
                                          <span className="text-xs shrink-0">
                                            이번달 <span className={`font-semibold ${zoneSched.done >= zoneSched.total ? 'text-green-600' : 'text-blue-600'}`}>{zoneSched.done}/{zoneSched.total}</span>
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => openEntryModal(zone)} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-100 rounded">수정</button>
                                        <button onClick={() => setDeleteConfirm({ ids: [zone.id], name: `${zone.name}[${zone.grade}]` })} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div key={grade} className="flex items-center gap-3 rounded-lg px-3 py-2 border border-dashed border-gray-200 bg-white/60">
                                    <span className={`text-xs font-bold px-2 py-1 rounded opacity-30 shrink-0 ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                                    <span className="text-xs text-gray-400 flex-1">등록되지 않음</span>
                                    <button
                                      onClick={e => { e.stopPropagation(); addGradeToGroup(group, grade); }}
                                      className="text-xs px-2.5 py-1 bg-gray-100 text-gray-500 hover:bg-gray-200 rounded font-medium shrink-0"
                                    >+ 추가</button>
                                  </div>
                                );
                              })}
                              {/* OQ / PQ if present */}
                              {group.zones.filter(z => !PROGRESSION.includes(z.grade)).map(zone => (
                                <div key={zone.id} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-white border border-gray-100">
                                  <span className={`text-xs font-bold px-2 py-1 rounded shrink-0 ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span>
                                  <span className="text-xs text-gray-500 flex-1">{zone.name}</span>
                                  <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                    <button onClick={() => openEntryModal(zone)} className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-100 rounded">수정</button>
                                    <button onClick={() => setDeleteConfirm({ ids: [zone.id], name: `${zone.name}[${zone.grade}]` })} className="text-xs px-2 py-1 text-red-400 hover:bg-red-50 rounded">삭제</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {filteredGroups.length === 0 && (
                  <tr><td colSpan={13} className="px-4 py-8 text-center text-sm text-gray-400">구역이 없습니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 데이터 입력 모달 */}
      {editEntry && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="font-bold text-gray-800">{editEntry.name} <span className={`text-xs px-2 py-0.5 rounded-full ml-2 ${GRADE_COLORS[editEntry.grade]}`}>{editEntry.grade}</span></h2>
            <p className="text-sm text-gray-500">{year}년 {month}월 모니터링 데이터 입력</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">시작일</label>
                <input type="date" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.start_date || ''} onChange={e => setEntryForm(f => ({ ...f, start_date: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500">
                  완료 횟수 (목표: {GRADE_TARGETS[editEntry.grade] || 1}회)
                  {editEntry.schedule_start && <span className="ml-1 text-blue-500">· 달력 연동</span>}
                </label>
                <input type="number" min="0" className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={entryForm.count || ''} onChange={e => setEntryForm(f => ({ ...f, count: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">측정포인트 수 <span className="ml-1 text-blue-500">· 달력 연동</span></label>
              {COMBINED_CATS.includes(editEntry.category) ? (
                <div className="mt-0.5">
                  <label className="text-[11px] text-gray-400 block text-center">통합 (부유균·낙하균·표면균·부유입자)</label>
                  <input type="number" min="0" className="w-full border rounded px-2 py-1.5 text-sm text-center" placeholder="0"
                    value={entryForm.airborne || ''} onChange={e => setEntryForm(f => ({ ...f, airborne: e.target.value }))} />
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2 mt-0.5">
                  {[['airborne','부유균'],['settle','낙하균'],['surface','표면균'],['particle','부유입자']].map(([key, label]) => (
                    <div key={key}>
                      <label className="text-[11px] text-gray-400 block text-center">{label}</label>
                      <input type="number" min="0" className="w-full border rounded px-2 py-1.5 text-sm text-center" placeholder="0" value={entryForm[key] || ''} onChange={e => setEntryForm(f => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500">비고</label>
              <textarea className="w-full border rounded px-2 py-1.5 text-sm mt-0.5 h-16 resize-none" value={entryForm.note || ''} onChange={e => setEntryForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={saveEntry} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">저장</button>
              <button onClick={() => setEditEntry(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* Error toast */}
      {errorMsg && (
        <div className="fixed top-4 right-4 z-[200] bg-red-500 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3 max-w-sm">
          <span className="text-base shrink-0 mt-0.5">⚠</span>
          <span className="text-sm font-medium flex-1 leading-snug">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-red-200 hover:text-white text-lg leading-none shrink-0">✕</button>
        </div>
      )}

      {/* 삭제 확인 모달 */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-gray-800">구역 삭제</h2>
            <p className="text-sm text-gray-500">
              <span className="font-semibold text-gray-700">{deleteConfirm.name}</span>
              {deleteConfirm.ids.length > 1 ? ` 그룹(${deleteConfirm.ids.length}개 등급)을` : ' 구역을'} 삭제하시겠습니까?
              이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2 pt-1">
              <button onClick={handleDeleteConfirmed}
                className="flex-1 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600">삭제</button>
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 구역 추가 모달 */}
      {showAddZone && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-800">구역 추가</h2>
            <p className="text-xs text-gray-400">같은 이름+분류의 구역은 자동으로 그룹화됩니다. P1/P2/P3/유지관리는 그룹 내 각 1개까지 허용됩니다.</p>
            <div>
              <label className="text-xs text-gray-500">구역명</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.name || ''} onChange={e => setZoneForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">등급</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.grade || ''} onChange={e => setZoneForm(f => ({ ...f, grade: e.target.value }))}>
                  <option value="">선택</option>
                  {GRADES.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">분류</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.category || '공조'} onChange={e => setZoneForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">청정등급</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm mt-0.5" value={zoneForm.clean_grade || ''} onChange={e => setZoneForm(f => ({ ...f, clean_grade: e.target.value }))}>
                <option value="">미지정</option>
                {CLEAN_GRADES.map(c => <option key={c} value={c}>{c}등급</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={handleAddZone} disabled={saving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">추가</button>
              <button onClick={() => setShowAddZone(false)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 새 그룹 만들기 모달 */}
      {newGroupModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setNewGroupModal(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-gray-800">새 그룹 만들기</h2>
            <p className="text-xs text-gray-400">
              <span className="font-semibold text-gray-600">{newGroupModal.zoneGroup.name}</span> 구역을 새 그룹으로 묶습니다.
            </p>
            <div>
              <label className="text-xs text-gray-500">그룹명</label>
              <input
                autoFocus
                className="w-full border rounded px-2 py-1.5 text-sm mt-0.5"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createGroupAndAssign(); }}
                placeholder="예: 1동 4층"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={createGroupAndAssign} disabled={!newGroupName.trim()} className="flex-1 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">만들기</button>
              <button onClick={() => setNewGroupModal(null)} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">취소</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 순서/그룹 관리 팝업 ─────────────────────────────────────────────── */}
      {showOrderModal && (
        <div className="fixed inset-0 z-[500]" style={{ pointerEvents: 'none' }}>
          {/* ── 팝업 컨테이너 (앱 스타일) ── */}
          <div
            className="absolute flex flex-col bg-white rounded-xl overflow-hidden"
            style={{ left: modalPos.x, top: modalPos.y, width: modalSize.w, height: modalSize.h, pointerEvents: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.30)', border: '1px solid #e5e7eb' }}
          >
            {/* 헤더 — 앱 사이드바 스타일 */}
            <div onMouseDown={startModalDrag} className="flex items-center justify-between px-4 bg-gray-900 text-white cursor-move shrink-0" style={{ height: 46 }}>
              <div className="flex items-center gap-2">
                <svg width="16" height="14" viewBox="0 0 16 13" fill="none">
                  <rect width="16" height="10" rx="1.5" fill="#fbbf24" y="2.5" />
                  <rect width="7" height="2.5" fill="#f59e0b" y="0.5" x="0.5" rx="1" />
                </svg>
                <span className="font-semibold text-sm">구역 순서 / 그룹 관리</span>
              </div>
              <button onClick={() => setShowOrderModal(false)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 text-gray-400 hover:text-white text-sm transition-colors">✕</button>
            </div>

            {/* 도구 모음 */}
            <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-gray-200 shrink-0 flex-wrap">
              {[
                { dir: 'top',    label: '맨위로',    icon: '⏫', dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'up10',   label: '10위',      icon: '▲▲', dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'up1',    label: '위로',      icon: '▲',  dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'down1',  label: '아래로',    icon: '▼',  dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
                { dir: 'down10', label: '10아래',    icon: '▼▼', dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
                { dir: 'bottom', label: '맨아래로',  icon: '⏬', dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
              ].map(btn => (
                <button key={btn.dir} onClick={() => moveModalSelected(btn.dir)} disabled={btn.dis}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border font-medium transition-colors ${btn.dis ? 'border-transparent text-gray-300 cursor-default' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-400 shadow-sm'}`}
                  title={btn.label}
                >
                  <span className="text-[10px]">{btn.icon}</span>
                  <span className="hidden sm:inline">{btn.label}</span>
                </button>
              ))}
              <div className="w-px h-5 bg-gray-200 mx-1" />
              <span className="text-xs text-gray-400">
                {modalSelectedIdx !== null ? `${modalSelectedIdx + 1} / ${modalGroups.length}` : `${modalGroups.length}개`}
              </span>
            </div>

            {/* 두 패널 — 왼쪽: 구역 목록, 오른쪽: 폴더 */}
            <div className="flex flex-1 min-h-0">
              {/* 왼쪽: 구역 목록 */}
              <div className="flex flex-col flex-1 min-w-0">
                {/* 열 머리글 */}
                <div className="flex items-center bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 shrink-0" style={{ height: 28 }}>
                  <div className="w-8 text-center shrink-0 text-gray-300">≡</div>
                  <div className="w-8 text-center shrink-0">#</div>
                  <div className="flex-1 pl-1">구역명</div>
                  <div className="w-18 text-center shrink-0" style={{ width: 68 }}>분류</div>
                  <div className="text-center shrink-0" style={{ width: 96 }}>등급</div>
                </div>
                {/* 행 목록 */}
                <div ref={modalListRef} className="flex-1 overflow-y-auto">
                  {modalGroups.map((group, idx) => {
                    const sel = idx === modalSelectedIdx;
                    const isDragOver = dropIdx === idx && dragIdx !== idx;
                    return (
                      <div
                        key={group.key}
                        data-modal-row={idx}
                        onClick={() => setModalSelectedIdx(idx)}
                        onDragOver={e => { e.preventDefault(); setDropIdx(idx); }}
                        onDragLeave={() => setDropIdx(null)}
                        onDrop={e => handleModalDrop(e, idx)}
                        className={`flex items-center text-xs cursor-pointer select-none transition-colors ${sel ? 'bg-blue-600 text-white' : idx % 2 === 0 ? 'bg-white hover:bg-blue-50' : 'bg-gray-50/60 hover:bg-blue-50'}`}
                        style={{ height: 28, borderTop: isDragOver ? '2px solid #2563eb' : '1px solid transparent', borderBottom: '1px solid #f3f4f6' }}
                      >
                        {/* 드래그 핸들 */}
                        <div
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('modalDragIdx', String(idx)); e.dataTransfer.effectAllowed = 'move'; setDragIdx(idx); }}
                          onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                          onClick={e => e.stopPropagation()}
                          className={`w-8 flex items-center justify-center cursor-grab shrink-0 text-base ${sel ? 'text-blue-300 hover:text-white' : 'text-gray-300 hover:text-gray-500'}`}
                          title="드래그하여 순서 변경"
                        >≡</div>
                        <div className={`w-8 text-center shrink-0 font-mono ${sel ? 'text-blue-200' : 'text-gray-300'}`} style={{ fontSize: 10 }}>{idx + 1}</div>
                        <div className="flex-1 flex items-center gap-2 min-w-0 px-1">
                          <svg width="14" height="12" viewBox="0 0 16 13" fill="none" className="shrink-0">
                            <rect width="16" height="10" rx="1" fill={sel ? '#93c5fd' : '#fbbf24'} y="2.5" />
                            <rect width="7" height="2.5" fill={sel ? '#60a5fa' : '#f59e0b'} y="0.5" x="0.5" rx="0.8" />
                          </svg>
                          <span className={`font-medium truncate ${sel ? 'text-white' : 'text-gray-800'}`}>{group.name}</span>
                        </div>
                        <div className={`text-center shrink-0 ${sel ? 'text-blue-100' : 'text-gray-400'}`} style={{ width: 68, fontSize: 10 }}>{group.category}</div>
                        <div className="flex items-center justify-center gap-1 shrink-0" style={{ width: 96 }}>
                          {group.zones.map(z => (
                            <span key={z.id} className={`text-[9px] px-1 py-px rounded ${sel ? 'bg-blue-400 text-white' : 'bg-gray-200 text-gray-600'}`}>{z.grade}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {modalGroups.length === 0 && (
                    <div className="text-center py-10 text-sm text-gray-400">구역이 없습니다</div>
                  )}
                </div>
              </div>

              {/* 오른쪽: 폴더(일정그룹) 패널 */}
              <div className="shrink-0 border-l border-gray-200 flex flex-col" style={{ width: 168 }}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200 shrink-0">일정그룹 (폴더화)</div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOverFolder('__none__'); }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={e => handleFolderDrop(e, '')}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${dragOverFolder === '__none__' ? 'bg-blue-100 border-blue-400 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'}`}
                  >
                    <span>📂</span><span>그룹 없음</span>
                  </div>
                  {modalNamedGroups.map(g => (
                    <div
                      key={g.id}
                      onDragOver={e => { e.preventDefault(); setDragOverFolder(String(g.id)); }}
                      onDragLeave={() => setDragOverFolder(null)}
                      onDrop={e => handleFolderDrop(e, String(g.id))}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${dragOverFolder === String(g.id) ? 'bg-blue-100 border-blue-400 text-blue-700' : 'bg-white border-gray-200 text-gray-700 hover:bg-blue-50 hover:border-blue-200'}`}
                    >
                      <span>📁</span>
                      <span className="font-medium truncate flex-1">{g.name}</span>
                      <span className="text-gray-400 shrink-0">{(g.zoneIds||[]).length}</span>
                    </div>
                  ))}
                  {showModalNewFolder ? (
                    <div className="space-y-1">
                      <input
                        autoFocus
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="폴더명"
                        value={modalNewFolderName}
                        onChange={e => setModalNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') addModalNewFolder(); if (e.key === 'Escape') setShowModalNewFolder(false); }}
                      />
                      <div className="flex gap-1">
                        <button onClick={addModalNewFolder} disabled={!modalNewFolderName.trim()} className="flex-1 text-xs py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">만들기</button>
                        <button onClick={() => { setShowModalNewFolder(false); setModalNewFolderName(''); }} className="flex-1 text-xs py-0.5 border border-gray-200 rounded text-gray-500 hover:bg-gray-50">취소</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowModalNewFolder(true)} className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs border border-dashed border-gray-300 text-gray-400 hover:bg-gray-50 hover:border-gray-400 hover:text-gray-600 transition-colors">
                      <span>+</span><span>새 폴더</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 상태 표시줄 */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-t border-gray-200 shrink-0">
              <span className="text-xs text-gray-500">
                {modalSelectedIdx !== null
                  ? `"${modalGroups[modalSelectedIdx]?.name}" 선택 — 버튼이나 ≡ 드래그로 이동 / 폴더에 드래그하여 그룹 배정`
                  : '구역 클릭 선택 후 이동, 또는 ≡ 핸들을 드래그하여 순서 변경'}
              </span>
              <div className="flex gap-2 shrink-0">
                <button onClick={saveOrderModal} disabled={modalSaving} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">{modalSaving ? '저장 중…' : '저장'}</button>
                <button onClick={() => setShowOrderModal(false)} className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-100 transition-colors">닫기</button>
              </div>
            </div>

            {/* 크기 조절 핸들 */}
            <div onMouseDown={startResize} className="absolute bottom-0 right-0 cursor-se-resize" style={{ width: 16, height: 16 }}>
              <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
                <path d="M16 4L4 16" stroke="#9ca3af" strokeWidth="1.5"/>
                <path d="M16 9L9 16" stroke="#9ca3af" strokeWidth="1.5"/>
                <path d="M16 14L14 16" stroke="#9ca3af" strokeWidth="1.5"/>
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* ─── 측정주기 설정 모달 ───────────────────────────────────────────────── */}
      {showCycleModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[400] p-4">
          <div className="bg-white rounded-2xl shadow-2xl flex flex-col" style={{ width: 560, maxHeight: '85vh' }}>
            {/* 헤더 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-bold text-gray-800">측정주기 설정</h2>
                <p className="text-xs text-gray-400 mt-0.5">변경 시 달력 일정이 즉시 재계산됩니다</p>
              </div>
              <button onClick={() => setShowCycleModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            {/* 분류 탭 */}
            <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-gray-100 shrink-0 flex-wrap">
              {categories.map(cat => (
                <button key={cat} onClick={() => setCycleCatTab(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${cycleCatTab === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                >{cat}</button>
              ))}
              <div className="flex-1" />
              {/* 새 분류 추가 */}
              {newCatName !== undefined && (
                <div className="flex items-center gap-1">
                  <input
                    className="text-xs border border-gray-300 rounded px-2 py-0.5 w-24 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="새 분류명"
                    value={newCatName}
                    onChange={e => setNewCatName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addCycleCategory(); }}
                  />
                  <button onClick={addCycleCategory} disabled={!newCatName.trim() || !!cycleConfig[newCatName.trim()]}
                    className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">추가</button>
                </div>
              )}
            </div>
            {/* 현재 분류 관리 */}
            <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
              <p className="text-xs text-gray-400">등급별 측정 횟수·간격을 설정합니다.</p>
              <div className="flex gap-2">
                {!['공조','압축공기','질소가스'].includes(cycleCatTab) && (
                  <button onClick={() => removeCycleCategory(cycleCatTab)} className="text-xs px-2 py-1 bg-red-50 text-red-500 rounded hover:bg-red-100">분류 삭제</button>
                )}
                <button onClick={() => resetCycleCategory(cycleCatTab)} className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-gray-200">기본값</button>
              </div>
            </div>
            {/* 등급별 설정 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {CYCLE_GRADES.map(grade => {
                const phases = cycleConfig[cycleCatTab]?.[grade] || [];
                const totalCnt = phases.reduce((s, p) => s + (p.count || 0), 0);
                return (
                  <div key={grade} className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${GRADE_COLORS[grade] || 'bg-gray-100 text-gray-600'}`}>{grade}</span>
                        <span className="text-xs text-gray-400">총 {totalCnt}회</span>
                      </div>
                      <button onClick={() => addCyclePhase(cycleCatTab, grade)} className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 font-medium">+ 구간</button>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {phases.length === 0 && <p className="px-3 py-2 text-xs text-gray-400 italic">구간 없음 — + 구간으로 추가</p>}
                      {phases.map((phase, idx) => {
                        const isMonthly = phase.type === 'monthly' || phase.type === 'quarterly';
                        return (
                          <div key={idx} className="flex items-center gap-2 px-3 py-2 flex-wrap">
                            <span className="text-[10px] text-gray-300 w-4 shrink-0">{idx + 1}</span>
                            <select value={phase.type} onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'type', e.target.value)}
                              className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                              {CYCLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                            <div className="flex items-center gap-1">
                              <input type="number" min="1" max="999" value={phase.count}
                                onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'count', e.target.value)}
                                className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                              <span className="text-xs text-gray-400">회</span>
                            </div>
                            {isMonthly ? (
                              <span className="text-xs text-gray-400">{phase.type === 'monthly' ? '1개월 간격' : '3개월 간격'}</span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-gray-400">간격</span>
                                <input type="number" min="1" max="365" value={phase.intervalDays ?? ''}
                                  onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'intervalDays', e.target.value)}
                                  className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                <span className="text-xs text-gray-400">일</span>
                              </div>
                            )}
                            <button onClick={() => removeCyclePhase(cycleCatTab, grade, idx)} className="ml-auto text-xs text-gray-300 hover:text-red-500 shrink-0" title="삭제">✕</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 shrink-0">
              <button onClick={() => setShowCycleModal(false)} className="w-full py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700">확인</button>
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
