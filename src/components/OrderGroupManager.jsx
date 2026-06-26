import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { upsertZone, deleteZone, upsertGroup, fetchScheduleConfig, saveScheduleConfig } from '../lib/api';
import { GRADE_PRIORITY, DEFAULT_SCHEDULE_SPECS, setScheduleConfig, getScheduleConfig, buildHolidayMap, computeCascadeSchedules, calcMeasurements, calcEndDate } from '../lib/schedule';
import { GRADE_COLORS, CLEAN_GRADES, CLEAN_GRADE_COLORS } from '../data/initialData';

const CYCLE_UNITS = [
  { value: 'day',   label: '일' },
  { value: 'week',  label: '주' },
  { value: 'month', label: '개월' },
];
const CYCLE_GRADES = ['P1', 'P2', 'P3', '유지관리'];
const BUILTIN_CATS = ['공조', '압축공기', '질소가스'];
const PROGRESSION = ['P1', 'P2', 'P3', '유지관리'];
const GRADES = ['P1', 'P2', 'P3', '유지관리', 'OQ', 'PQ'];

function buildOrderedGroups(zones) {
  const map = {};
  zones.forEach(zone => {
    const key = `${zone.category}|||${zone.name}`;
    if (!map[key]) map[key] = { name: zone.name, category: zone.category, key, zones: [] };
    map[key].zones.push(zone);
  });
  Object.values(map).forEach(g => {
    g.zones.sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0));
  });
  const arr = Object.values(map);
  arr.sort((a, b) => (Math.min(...a.zones.map(z => z.sort_order ?? 1e9)) - Math.min(...b.zones.map(z => z.sort_order ?? 1e9))) || a.name.localeCompare(b.name));
  return arr;
}


// 셀 세로 구분선
function cellBorder(sel) {
  return sel ? 'border-r border-blue-400/40' : 'border-r border-gray-100';
}

// 컬럼 정의 — 헤더 드래그로 순서 변경, 우측 핸들로 너비 조절
const COL_DEFS = {
  num:         { label: '#',        width: 36 },
  name:        { label: '구역명',    flex: true, minWidth: 120 },
  category:    { label: '분류',      width: 60 },
  clean_grade: { label: '청정등급',  width: 70 },
  start:       { label: '시작일',    width: 92 },
  end:         { label: '종료예정일', width: 92 },
  dday:        { label: 'D-day',     width: 64 },
  float:       { label: '부유균',    width: 48 },
  fall:        { label: '낙하균',    width: 48 },
  surface:     { label: '표면균',    width: 48 },
  particle:    { label: '부유입자',  width: 52 },
  count:       { label: '측정횟수',  width: 64 },
  progress:    { label: '진행상황',  width: 72 },
  grade:       { label: '구분',      width: 60 },
};
const DEFAULT_COL_ORDER = Object.keys(COL_DEFS);
const POINT_FIELD = { float: 'points_float', fall: 'points_fall', surface: 'points_surface', particle: 'points_particle' };
const STATUS_STYLE = { '예정': 'bg-gray-100 text-gray-500', '진행중': 'bg-blue-100 text-blue-600', '완료': 'bg-emerald-100 text-emerald-600' };
const HANDLE_W = 32;
const ACTION_W = 28;

function fmtDate(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';
}
function ddayLabel(n) {
  if (n == null) return '—';
  if (n > 0) return `D-${n}`;
  if (n === 0) return 'D-DAY';
  return `D+${-n}`;
}
function ddayColor(n, sel) {
  if (sel) return 'text-blue-100';
  if (n == null) return 'text-gray-300';
  if (n > 30) return 'text-gray-400';   // 31일 이상 — 회색
  if (n > 7)  return 'text-emerald-600'; // 8~30일 — 초록
  if (n >= 0) return 'text-yellow-500';  // 0~7일 — 노랑
  return 'text-red-500';                 // D+1 이후 — 빨강
}

/**
 * 구역 순서 / 그룹(폴더) 관리 + 측정주기 설정 통합 팝업.
 *
 * props:
 *  - zones, groups: 현재 데이터
 *  - holidayDefs: 공휴일 정의 배열 (cascade schedule 계산용)
 *  - onClose(): 닫기
 *  - onSaved(updatedZones, updatedGroups): 저장 후 부모 데이터 갱신
 */
export default function OrderGroupManager({ zones, groups, holidayDefs = [], onClose, onSaved, docked = false }) {
  const [activeTab, setActiveTab] = useState('order'); // 'order' | 'cycle'
  const [modalGroups, setModalGroups] = useState(() =>
    buildOrderedGroups(zones).map(g => ({
      ...g,
      zones: g.zones.map(z => ({ ...z }))
    }))
  );
  const [modalNamedGroups, setModalNamedGroups] = useState(() =>
    groups.map(g => ({ ...g, zoneIds: [...(g.zoneIds || [])] }))
  );
  const [modalSelectedIdx, setModalSelectedIdx] = useState(null);
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [folderFilter, setFolderFilter] = useState(null); // null = 전체, or namedGroup id
  const [pos, setPos] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('em-ogm-pos')); if (s && typeof s.x === 'number') return s; } catch { /* ignore */ }
    return { x: 80, y: 60 };
  });
  const [size, setSize] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('em-ogm-size')); if (s && typeof s.w === 'number') return s; } catch { /* ignore */ }
    return { w: 980, h: 600 };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  // 로컬 편집 변경사항 tracking: { zoneId: { ...fields } }
  const [localEdits, setLocalEdits] = useState({});
  // 새 구역 추가 폼
  const [showAddZone, setShowAddZone] = useState(false);
  const [addZoneName, setAddZoneName] = useState('');
  const [addZoneCategory, setAddZoneCategory] = useState('공조');
  const [addZoneGrade, setAddZoneGrade] = useState('P1');
  const [addZoneCleanGrade, setAddZoneCleanGrade] = useState('A');
  // 우클릭 컨텍스트 메뉴
  const [contextMenu, setContextMenu] = useState(null); // { x, y, groupIdx }
  const contextMenuRef = useRef(null);
  // 측정주기 설정
  const [cycleConfig, setCycleConfig] = useState(() => getScheduleConfig());
  const [cycleCatTab, setCycleCatTab] = useState(() => Object.keys(getScheduleConfig())[0] || '공조');
  const [newCatName, setNewCatName] = useState('');
  // 컬럼 순서 / 너비 (localStorage 영속)
  const [colOrder, setColOrder] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('em-ogm-col-order'));
      if (Array.isArray(s)) {
        const valid = s.filter(k => COL_DEFS[k]);
        DEFAULT_COL_ORDER.forEach(k => { if (!valid.includes(k)) valid.push(k); });
        return valid;
      }
    } catch { /* ignore */ }
    return [...DEFAULT_COL_ORDER];
  });
  const [colWidths, setColWidths] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('em-ogm-col-widths')); if (s && typeof s === 'object') return s; } catch { /* ignore */ }
    return {};
  });
  const [colDragKey, setColDragKey] = useState(null);
  const [colDropKey, setColDropKey] = useState(null);

  const dragOffset = useRef(null);
  const listRef = useRef(null);

  const categories = useMemo(() => Object.keys(cycleConfig), [cycleConfig]);

  // 측정주기 설정 동기화
  useEffect(() => {
    fetchScheduleConfig().then(cfg => {
      if (cfg) {
        setScheduleConfig(cfg);
        setCycleConfig(cfg);
        setCycleCatTab(Object.keys(cfg)[0] || '공조');
      }
    }).catch(() => {});
  }, []);

  // 선택 행 자동 스크롤
  useEffect(() => {
    if (modalSelectedIdx === null || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-modal-row="${modalSelectedIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [modalSelectedIdx]);

  // 우클릭 메뉴 click-outside 닫기
  useEffect(() => {
    if (!contextMenu) return;
    function onDown(e) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) {
        setContextMenu(null);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [contextMenu]);

  // 폴더 필터링된 그룹 목록
  const filteredGroups = useMemo(() => {
    if (folderFilter === null) return modalGroups;
    if (folderFilter === '__none__') {
      // 어떤 그룹에도 속하지 않은 구역들
      const allGroupedIds = new Set(modalNamedGroups.flatMap(g => g.zoneIds || []));
      return modalGroups.filter(g => g.zones.some(z => !allGroupedIds.has(z.id)));
    }
    const namedGroup = modalNamedGroups.find(g => String(g.id) === String(folderFilter));
    if (!namedGroup) return modalGroups;
    const ids = new Set(namedGroup.zoneIds || []);
    return modalGroups.filter(g => g.zones.some(z => ids.has(z.id)));
  }, [modalGroups, modalNamedGroups, folderFilter]);

  // 인덱스를 실제 modalGroups 내 인덱스로 변환
  function getRealIdx(filteredIdx) {
    const group = filteredGroups[filteredIdx];
    if (!group) return -1;
    return modalGroups.findIndex(g => g.key === group.key);
  }

  // ─── 순서 이동 ──────────────────────────────────────────────
  function moveModalSelected(dir) {
    if (modalSelectedIdx === null) return;
    const realIdx = getRealIdx(modalSelectedIdx);
    if (realIdx < 0) return;
    const arr = [...modalGroups];
    let newRealIdx;
    if (dir === 'top')         newRealIdx = 0;
    else if (dir === 'up10')   newRealIdx = Math.max(0, realIdx - 10);
    else if (dir === 'up1')    newRealIdx = Math.max(0, realIdx - 1);
    else if (dir === 'down1')  newRealIdx = Math.min(arr.length - 1, realIdx + 1);
    else if (dir === 'down10') newRealIdx = Math.min(arr.length - 1, realIdx + 10);
    else if (dir === 'bottom') newRealIdx = arr.length - 1;
    else return;
    if (newRealIdx === realIdx) return;
    const [item] = arr.splice(realIdx, 1);
    arr.splice(newRealIdx, 0, item);
    setModalGroups(arr);
    // filteredGroups를 재계산하여 새 인덱스를 찾음
    // (간단히 null로 초기화 후 첫 번째 선택)
    setModalSelectedIdx(null);
  }

  function handleModalDrop(e, targetFilteredIdx) {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData('modalDragIdx');
    if (!fromStr) return;
    const fromFilteredIdx = parseInt(fromStr);
    if (!isNaN(fromFilteredIdx) && fromFilteredIdx !== targetFilteredIdx) {
      const fromRealIdx = getRealIdx(fromFilteredIdx);
      const toRealIdx = getRealIdx(targetFilteredIdx);
      if (fromRealIdx < 0 || toRealIdx < 0) return;
      const arr = [...modalGroups];
      const [item] = arr.splice(fromRealIdx, 1);
      arr.splice(toRealIdx, 0, item);
      setModalGroups(arr);
      setModalSelectedIdx(targetFilteredIdx);
    }
    setDragIdx(null); setDropIdx(null);
  }

  function handleFolderDrop(e, namedGroupId) {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData('modalDragIdx');
    if (!fromStr) return;
    const fromFilteredIdx = parseInt(fromStr);
    if (!isNaN(fromFilteredIdx)) {
      const realIdx = getRealIdx(fromFilteredIdx);
      if (realIdx >= 0) modalAssignGroup(realIdx, namedGroupId || '');
    }
    setDragIdx(null); setDragOverFolder(null);
  }

  async function addNewFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const saved = await upsertGroup({ name, zoneIds: [] });
      setModalNamedGroups(prev => [...prev, saved]);
      setNewFolderName('');
      setShowNewFolder(false);
    } catch (e) { setError('폴더 생성 실패: ' + e.message); }
  }

  function modalAssignGroup(realIdx, namedGroupId) {
    const ids = modalGroups[realIdx]?.zones.map(z => z.id) || [];
    setModalNamedGroups(prev => prev.map(g => {
      const has = (g.zoneIds || []).some(id => ids.includes(id));
      const shouldHave = String(g.id) === String(namedGroupId);
      if (has && !shouldHave) return { ...g, zoneIds: g.zoneIds.filter(id => !ids.includes(id)) };
      if (!has && shouldHave) return { ...g, zoneIds: [...new Set([...(g.zoneIds || []), ...ids])] };
      return g;
    }));
  }

  // ─── 로컬 편집 ──────────────────────────────────────────────
  function getZoneValue(zone, field) {
    if (localEdits[zone.id] && field in localEdits[zone.id]) return localEdits[zone.id][field];
    return zone[field];
  }

  function editZoneField(zoneId, field, value) {
    setLocalEdits(prev => ({
      ...prev,
      [zoneId]: { ...(prev[zoneId] || {}), [field]: value }
    }));
  }

  // 분류 변경 — 그룹 내 모든 등급(zone)에 일괄 적용
  function editGroupCategory(groupKey, newCat) {
    const grp = modalGroups.find(g => g.key === groupKey);
    const ids = grp?.zones.map(z => z.id) || [];
    setModalGroups(prev => prev.map(g =>
      g.key === groupKey
        ? { ...g, category: newCat, zones: g.zones.map(z => ({ ...z, category: newCat })) }
        : g
    ));
    setLocalEdits(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = { ...(next[id] || {}), category: newCat }; });
      return next;
    });
  }

  function handleDateBlur(zone) {
    // cascade: P1/P2/P3인 경우 이후 등급 시작일 자동 계산
    if (!PROGRESSION.includes(zone.grade)) return;
    const dateStr = getZoneValue(zone, 'schedule_start');
    if (!dateStr) return;
    try {
      const startYear = new Date(dateStr).getFullYear();
      const holidayMap = buildHolidayMap(holidayDefs, startYear, startYear + 4);
      const allZones = modalGroups.flatMap(g =>
        g.zones.map(z => ({ ...z, ...(localEdits[z.id] || {}) }))
      );
      const mergedZone = { ...zone, ...(localEdits[zone.id] || {}) };
      // computeCascadeSchedules returns [{ zoneData }]
      const cascadeResult = computeCascadeSchedules(mergedZone, allZones, holidayMap);
      if (cascadeResult && cascadeResult.length > 0) {
        const newEdits = { ...localEdits };
        cascadeResult.forEach(({ zoneData: zd }) => {
          if (zd.id && zd.id !== zone.id) {
            newEdits[zd.id] = { ...(newEdits[zd.id] || {}), schedule_start: zd.schedule_start, schedule_overrides: {} };
          }
        });
        setLocalEdits(newEdits);
        setModalGroups(prev => prev.map(g => ({
          ...g,
          zones: g.zones.map(z => {
            const hit = cascadeResult.find(({ zoneData: zd }) => zd.id === z.id);
            return hit ? { ...z, ...hit.zoneData } : z;
          })
        })));
      }
    } catch (err) {
      console.warn('cascade error:', err);
    }
  }

  // ─── 구역 추가 ──────────────────────────────────────────────
  async function handleAddZone() {
    const name = addZoneName.trim();
    if (!name) return;
    try {
      const newZone = {
        name,
        category: addZoneCategory,
        grade: addZoneGrade,
        clean_grade: addZoneCleanGrade,
        sort_order: modalGroups.length * 1000,
      };
      const saved = await upsertZone(newZone);
      const key = `${saved.category}|||${saved.name}`;
      // 기존 그룹에 추가하거나 새 그룹 생성
      setModalGroups(prev => {
        const existing = prev.find(g => g.key === key);
        if (existing) {
          return prev.map(g => g.key === key
            ? { ...g, zones: [...g.zones, saved].sort((a, b) => (GRADE_PRIORITY[b.grade] || 0) - (GRADE_PRIORITY[a.grade] || 0)) }
            : g
          );
        }
        return [{ name: saved.name, category: saved.category, key, zones: [saved] }, ...prev];
      });
      setAddZoneName('');
      setAddZoneGrade('P1');
      setAddZoneCleanGrade('A');
      setShowAddZone(false);
    } catch (e) {
      setError('구역 추가 실패: ' + e.message);
    }
  }

  // ─── 구역(등급) 삭제 ────────────────────────────────────────
  async function handleDeleteZoneGrade(groupKey, zoneId) {
    try {
      await deleteZone(zoneId);
      setModalGroups(prev => {
        return prev
          .map(g => {
            if (g.key !== groupKey) return g;
            const newZones = g.zones.filter(z => z.id !== zoneId);
            return newZones.length === 0 ? null : { ...g, zones: newZones };
          })
          .filter(Boolean);
      });
      setLocalEdits(prev => {
        const next = { ...prev };
        delete next[zoneId];
        return next;
      });
    } catch (e) {
      setError('삭제 실패: ' + e.message);
    }
  }

  // ─── 저장 ──────────────────────────────────────────────────
  async function saveOrderModal() {
    setSaving(true);
    try {
      const zoneUpdates = [];
      modalGroups.forEach((g, gi) => {
        g.zones.forEach((z, zi) => {
          const edits = localEdits[z.id] || {};
          zoneUpdates.push({ ...z, ...edits, sort_order: gi * 1000 + zi });
        });
      });
      for (const u of zoneUpdates) await upsertZone(u);
      for (const g of modalNamedGroups) await upsertGroup(g);
      // updatedZones: 원본 zones를 기준으로 합침
      const updatedZones = zones
        .map(z => zoneUpdates.find(u => u.id === z.id) || z)
        .concat(zoneUpdates.filter(u => !zones.find(z => z.id === u.id)));
      onSaved?.(updatedZones, modalNamedGroups);
      onClose?.();
    } catch (e) {
      setError('저장 실패: ' + e.message);
    }
    setSaving(false);
  }

  // ─── 창 이동 / 크기 조절 ─────────────────────────────────────
  function startDrag(e) {
    if (e.button !== 0) return;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const onMove = ev => {
      if (!dragOffset.current) return;
      setPos({ x: ev.clientX - dragOffset.current.x, y: ev.clientY - dragOffset.current.y });
    };
    const onUp = () => {
      dragOffset.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = size.w, startH = size.h;
    const onMove = ev => setSize({ w: Math.max(700, startW + ev.clientX - startX), h: Math.max(400, startH + ev.clientY - startY) });
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ─── 측정주기 설정 ──────────────────────────────────────────
  function applyCycleConfig(nextCfg) {
    setScheduleConfig(nextCfg);
    setCycleConfig(nextCfg);
    saveScheduleConfig(nextCfg);
  }

  function editCyclePhase(cat, grade, idx, field, value) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    if (!next[cat]?.[grade]?.[idx]) return;
    const phase = next[cat][grade][idx];
    if (field === 'unit') {
      phase.unit = value;
    } else if (field === 'interval') {
      phase.interval = Math.max(1, parseInt(value) || 1);
    } else if (field === 'count') {
      phase.count = Math.max(1, parseInt(value) || 1);
    }
    applyCycleConfig(next);
  }

  function addCyclePhase(cat, grade) {
    const next = JSON.parse(JSON.stringify(cycleConfig));
    if (!next[cat]) next[cat] = {};
    if (!next[cat][grade]) next[cat][grade] = [];
    next[cat][grade].push({ count: 1, unit: 'week', interval: 2 });
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
    if (BUILTIN_CATS.includes(cat)) return;
    const next = JSON.parse(JSON.stringify(cycleConfig));
    delete next[cat];
    applyCycleConfig(next);
    setCycleCatTab(Object.keys(next)[0] || '공조');
  }

  // 폴더당 구역 개수
  function folderZoneCount(namedGroup) {
    const ids = new Set(namedGroup.zoneIds || []);
    return modalGroups.filter(g => g.zones.some(z => ids.has(z.id))).length;
  }

  function ungroupedCount() {
    const allGroupedIds = new Set(modalNamedGroups.flatMap(g => g.zoneIds || []));
    return modalGroups.filter(g => g.zones.some(z => !allGroupedIds.has(z.id))).length;
  }

  // 오늘 날짜 기준 활성 zone 찾기
  function getActiveZone(group) {
    const todayStr = new Date().toISOString().slice(0, 10);
    // 시작일이 오늘 이전이면서 가장 최근인 것
    const candidates = group.zones
      .filter(z => z.schedule_start && z.schedule_start <= todayStr)
      .sort((a, b) => b.schedule_start.localeCompare(a.schedule_start));
    return candidates[0] || group.zones[0];
  }

  // ─── 컬럼 순서/너비 ─────────────────────────────────────────
  useEffect(() => { try { localStorage.setItem('em-ogm-col-order', JSON.stringify(colOrder)); } catch { /* ignore */ } }, [colOrder]);
  useEffect(() => { try { localStorage.setItem('em-ogm-col-widths', JSON.stringify(colWidths)); } catch { /* ignore */ } }, [colWidths]);
  useEffect(() => { try { localStorage.setItem('em-ogm-pos', JSON.stringify(pos)); } catch { /* ignore */ } }, [pos]);
  useEffect(() => { try { localStorage.setItem('em-ogm-size', JSON.stringify(size)); } catch { /* ignore */ } }, [size]);

  function colWidth(key) { return colWidths[key] ?? COL_DEFS[key].width; }

  function startColResize(e, key) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidth(key) || 60;
    const onMove = ev => {
      const w = Math.max(28, startW + ev.clientX - startX);
      setColWidths(prev => ({ ...prev, [key]: w }));
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function reorderCol(fromKey, toKey) {
    if (!fromKey || fromKey === toKey) return;
    setColOrder(prev => {
      const arr = prev.filter(k => k !== fromKey);
      const ti = arr.indexOf(toKey);
      if (ti < 0) return prev;
      arr.splice(ti, 0, fromKey);
      return arr;
    });
  }

  // 측정 진행 통계
  const todayMid = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const statHolidayMap = useMemo(() => {
    const y = todayMid.getFullYear();
    try { return buildHolidayMap(holidayDefs, y - 2, y + 5); } catch { return {}; }
  }, [holidayDefs, todayMid]);

  function zoneStats(zone) {
    const z = { ...zone, ...(localEdits[zone.id] || {}) };
    if (!z.schedule_start) return { status: null, done: 0, total: 0, endDate: null, dday: null };
    let ms = [];
    try { ms = calcMeasurements(z, statHolidayMap); } catch { /* ignore */ }
    const total = ms.length;
    const done = ms.filter(m => m.date <= todayMid).length;
    let endDate = null;
    try { endDate = calcEndDate(z); } catch { /* ignore */ }
    const startDate = new Date(z.schedule_start + 'T00:00:00');
    let status;
    if (todayMid < startDate) status = '예정';
    else if (total > 0 && done >= total) status = '완료';
    else status = '진행중';
    const dday = endDate ? Math.ceil((endDate - todayMid) / 86400000) : null;
    return { status, done, total, endDate, dday };
  }

  // 헤더 셀 렌더링 (드래그 순서 변경 + 너비 조절)
  function renderHeaderCell(key) {
    const def = COL_DEFS[key];
    const isFlex = !!def.flex;
    const isDrop = colDropKey === key && colDragKey && colDragKey !== key;
    return (
      <div
        key={key}
        onDragOver={e => { if (colDragKey) { e.preventDefault(); setColDropKey(key); } }}
        onDragLeave={() => setColDropKey(c => (c === key ? null : c))}
        onDrop={e => { const fk = e.dataTransfer.getData('colDragKey'); if (fk) { e.preventDefault(); reorderCol(fk, key); } setColDragKey(null); setColDropKey(null); }}
        className={`relative flex items-center justify-center text-center border-r border-gray-200 ${isFlex ? 'flex-1 min-w-0' : 'shrink-0'} ${isDrop ? 'bg-blue-200' : ''}`}
        style={isFlex ? { minWidth: def.minWidth } : { width: colWidth(key) }}
      >
        <span
          draggable
          onDragStart={e => { e.dataTransfer.setData('colDragKey', key); e.dataTransfer.effectAllowed = 'move'; setColDragKey(key); }}
          onDragEnd={() => { setColDragKey(null); setColDropKey(null); }}
          className={`truncate px-1 cursor-move ${colDragKey === key ? 'opacity-40' : ''}`}
          title="드래그하여 컬럼 순서 변경"
        >{def.label}</span>
        {!isFlex && (
          <div
            onMouseDown={e => startColResize(e, key)}
            onClick={e => e.stopPropagation()}
            draggable={false}
            onDragStart={e => e.preventDefault()}
            className="absolute top-0 h-full cursor-col-resize hover:bg-blue-400/50"
            style={{ right: 0, width: 6, transform: 'translateX(50%)', zIndex: 2 }}
            title="드래그하여 너비 조절"
          />
        )}
      </div>
    );
  }

  return (
    <div className={docked ? 'fixed inset-0 z-[500]' : 'fixed inset-0 z-[500]'} style={{ pointerEvents: docked ? 'auto' : 'none' }}>
      <div
        className={`flex flex-col bg-white overflow-hidden ${docked ? 'w-full h-full' : 'absolute rounded-xl'}`}
        style={docked
          ? { pointerEvents: 'auto' }
          : { left: pos.x, top: pos.y, width: size.w, height: size.h, pointerEvents: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.30)', border: '1px solid #e5e7eb' }}
      >
        {/* 헤더 */}
        <div onMouseDown={docked ? undefined : startDrag} className={`flex items-center justify-between px-4 bg-gray-900 text-white shrink-0 ${docked ? '' : 'cursor-move'}`} style={{ height: 46, ...(docked ? { WebkitAppRegion: 'drag' } : {}) }}>
          <div className="flex items-center gap-2" style={docked ? { WebkitAppRegion: 'drag' } : {}}>
            <svg width="16" height="14" viewBox="0 0 16 13" fill="none">
              <rect width="16" height="10" rx="1.5" fill="#fbbf24" y="2.5" />
              <rect width="7" height="2.5" fill="#f59e0b" y="0.5" x="0.5" rx="1" />
            </svg>
            <span className="font-semibold text-sm">구역 순서 / 그룹 · 측정주기 관리</span>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 text-gray-400 hover:text-white text-sm transition-colors" style={docked ? { WebkitAppRegion: 'no-drag' } : {}}>✕</button>
        </div>

        {/* 탭 */}
        <div className="flex items-center gap-1 px-3 pt-2 bg-white border-b border-gray-200 shrink-0">
          {[['order', '🗂 순서 / 그룹'], ['cycle', '⚙ 측정주기 설정']].map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg border-b-2 transition-colors ${activeTab === key ? 'border-blue-600 text-blue-600 bg-blue-50/50' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            >{label}</button>
          ))}
        </div>

        {activeTab === 'order' ? (
          <>
            {/* 도구 모음 */}
            <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-gray-200 shrink-0 flex-wrap">
              {[
                { dir: 'top',    label: '맨위로',   icon: '⏫', dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'up10',   label: '10위',     icon: '▲▲', dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'up1',    label: '위로',     icon: '▲',  dis: modalSelectedIdx === null || modalSelectedIdx === 0 },
                { dir: 'down1',  label: '아래로',   icon: '▼',  dis: modalSelectedIdx === null || modalSelectedIdx >= filteredGroups.length - 1 },
                { dir: 'down10', label: '10아래',   icon: '▼▼', dis: modalSelectedIdx === null || modalSelectedIdx >= filteredGroups.length - 1 },
                { dir: 'bottom', label: '맨아래로', icon: '⏬', dis: modalSelectedIdx === null || modalSelectedIdx >= filteredGroups.length - 1 },
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
              <button
                onClick={() => setShowAddZone(v => !v)}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium"
              >
                <span>+</span><span>구역 추가</span>
              </button>
              <div className="w-px h-5 bg-gray-200 mx-1" />
              <span className="text-xs text-gray-400">
                {modalSelectedIdx !== null ? `${modalSelectedIdx + 1} / ${filteredGroups.length}` : `${filteredGroups.length}개`}
              </span>
            </div>

            {/* 구역 추가 인라인 폼 */}
            {showAddZone && (
              <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border-b border-blue-200 shrink-0 flex-wrap">
                <input
                  autoFocus
                  className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
                  placeholder="구역명"
                  value={addZoneName}
                  onChange={e => setAddZoneName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddZone(); if (e.key === 'Escape') setShowAddZone(false); }}
                />
                <select value={addZoneCategory} onChange={e => setAddZoneCategory(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={addZoneGrade} onChange={e => setAddZoneGrade(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <select value={addZoneCleanGrade} onChange={e => setAddZoneCleanGrade(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  {CLEAN_GRADES.map(g => <option key={g} value={g}>청정{g}</option>)}
                </select>
                <button onClick={handleAddZone} disabled={!addZoneName.trim()}
                  className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">추가</button>
                <button onClick={() => { setShowAddZone(false); setAddZoneName(''); }}
                  className="text-xs px-2 py-1 border border-gray-200 rounded text-gray-500 hover:bg-gray-50">취소</button>
              </div>
            )}

            {/* 두 패널 */}
            <div className="flex flex-1 min-h-0">
              {/* 왼쪽: 구역 목록 */}
              <div className="flex flex-col flex-1 min-w-0">
                  {/* 목록 (헤더 포함 — sticky로 스크롤바 폭 자동 보정) */}
                <div ref={listRef} className="flex-1 overflow-y-auto">
                {/* sticky 컬럼 헤더 */}
                <div className="sticky top-0 z-20 flex items-stretch bg-gray-100 border-b border-gray-300 text-xs font-semibold text-gray-600 select-none" style={{ height: 30 }}>
                  <div className="shrink-0 flex items-center justify-center text-center text-gray-300 border-r border-gray-200" style={{ width: HANDLE_W }}>≡</div>
                  {colOrder.map(renderHeaderCell)}
                  <div className="shrink-0" style={{ width: ACTION_W }}></div>
                </div>
                  {filteredGroups.map((group, filteredIdx) => {
                    const sel = filteredIdx === modalSelectedIdx;
                    const isDragOver = dropIdx === filteredIdx && dragIdx !== filteredIdx;
                    const isExpanded = expandedRows.has(group.key);
                    const activeZone = getActiveZone(group);
                    const firstZone = group.zones[0];
                    const stats = activeZone ? zoneStats(activeZone) : { status: null, done: 0, total: 0, endDate: null, dday: null };

                    return (
                      <div key={group.key}>
                        {/* 접힌 행 (그룹 요약) */}
                        <div
                          data-modal-row={filteredIdx}
                          onClick={() => setModalSelectedIdx(filteredIdx === modalSelectedIdx ? null : filteredIdx)}
                          onContextMenu={e => {
                            e.preventDefault();
                            setContextMenu({ x: e.clientX, y: e.clientY, groupIdx: getRealIdx(filteredIdx) });
                          }}
                          onDragOver={e => { e.preventDefault(); setDropIdx(filteredIdx); }}
                          onDragLeave={() => setDropIdx(null)}
                          onDrop={e => handleModalDrop(e, filteredIdx)}
                          className={`flex items-center text-xs cursor-pointer select-none transition-colors ${sel ? 'bg-blue-600 text-white' : filteredIdx % 2 === 0 ? 'bg-white hover:bg-blue-50' : 'bg-gray-50/60 hover:bg-blue-50'}`}
                          style={{ height: 28, borderTop: isDragOver ? '2px solid #2563eb' : '1px solid transparent', borderBottom: '1px solid #f3f4f6' }}
                        >
                          {/* 드래그 핸들 */}
                          <div
                            draggable
                            onDragStart={e => { e.dataTransfer.setData('modalDragIdx', String(filteredIdx)); e.dataTransfer.effectAllowed = 'move'; setDragIdx(filteredIdx); }}
                            onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                            onClick={e => e.stopPropagation()}
                            className={`flex items-center justify-center cursor-grab shrink-0 text-base h-full ${cellBorder(sel)} ${sel ? 'text-blue-300 hover:text-white' : 'text-gray-300 hover:text-gray-500'}`}
                            style={{ width: 32 }}
                            title="드래그하여 순서 변경"
                          >≡</div>
                          {colOrder.map(key => {
                            const def = COL_DEFS[key];
                            const isFlex = !!def.flex;
                            const wStyle = isFlex ? { minWidth: def.minWidth } : { width: colWidth(key) };
                            const wClass = isFlex ? 'flex-1 min-w-0' : 'shrink-0';
                            const base = `flex items-center justify-center text-center h-full ${wClass} ${cellBorder(sel)}`;
                            const dim = sel ? 'text-blue-100' : 'text-gray-400';
                            if (key === 'name') {
                              return (
                                <div key={key} className={`flex items-center gap-1 min-w-0 px-1 h-full flex-1 ${cellBorder(sel)}`} style={{ minWidth: def.minWidth }}>
                                  <button
                                    onClick={e => { e.stopPropagation(); setExpandedRows(prev => { const s = new Set(prev); s.has(group.key) ? s.delete(group.key) : s.add(group.key); return s; }); }}
                                    className={`shrink-0 text-[10px] transition-transform ${isExpanded ? 'rotate-90' : ''} ${sel ? 'text-blue-200' : 'text-gray-400'}`}
                                  >▶</button>
                                  <span className={`font-medium truncate ${sel ? 'text-white' : 'text-gray-800'}`}>{group.name}</span>
                                </div>
                              );
                            }
                            if (key === 'num') return <div key={key} className={`${base} font-mono ${sel ? 'text-blue-200' : 'text-gray-300'}`} style={{ ...wStyle, fontSize: 10 }}>{filteredIdx + 1}</div>;
                            if (key === 'category') return <div key={key} className={`${base} ${dim} truncate px-0.5`} style={{ ...wStyle, fontSize: 10 }}>{group.category}</div>;
                            if (key === 'clean_grade') return (
                              <div key={key} className={base} style={wStyle}>
                                {firstZone?.clean_grade
                                  ? <span className={`text-[9px] px-1 py-px rounded ${sel ? 'bg-blue-400 text-white' : (CLEAN_GRADE_COLORS[firstZone.clean_grade] || 'bg-gray-100 text-gray-500')}`}>{firstZone.clean_grade}</span>
                                  : <span className={`text-[9px] ${sel ? 'text-blue-200' : 'text-gray-300'}`}>—</span>}
                              </div>
                            );
                            if (key === 'start') return <div key={key} className={`${base} ${dim}`} style={{ ...wStyle, fontSize: 10 }}>{activeZone?.schedule_start || '—'}</div>;
                            if (key === 'end') return <div key={key} className={`${base} ${dim}`} style={{ ...wStyle, fontSize: 10 }}>{fmtDate(stats.endDate)}</div>;
                            if (key === 'dday') return <div key={key} className={`${base} font-mono ${ddayColor(stats.dday, sel)}`} style={{ ...wStyle, fontSize: 10 }}>{ddayLabel(stats.dday)}</div>;
                            if (POINT_FIELD[key]) return <div key={key} className={`${base} ${dim}`} style={{ ...wStyle, fontSize: 10 }}>{getZoneValue(activeZone || {}, POINT_FIELD[key]) ?? '—'}</div>;
                            if (key === 'count') return <div key={key} className={`${base} font-mono ${dim}`} style={{ ...wStyle, fontSize: 10 }}>{stats.total ? `${stats.done}/${stats.total}` : '—'}</div>;
                            if (key === 'progress') return (
                              <div key={key} className={base} style={wStyle}>
                                {stats.status
                                  ? <span className={`text-[9px] px-1.5 py-px rounded font-medium ${sel ? 'bg-blue-400 text-white' : STATUS_STYLE[stats.status]}`}>{stats.status}</span>
                                  : <span className={`text-[9px] ${sel ? 'text-blue-200' : 'text-gray-300'}`}>—</span>}
                              </div>
                            );
                            if (key === 'grade') return (
                              <div key={key} className={base} style={wStyle}>
                                {activeZone && <span className={`text-[9px] px-1 py-px rounded font-bold ${sel ? 'bg-blue-400 text-white' : (GRADE_COLORS[activeZone.grade] || 'bg-gray-100 text-gray-600')}`}>{activeZone.grade}</span>}
                              </div>
                            );
                            return <div key={key} className={base} style={wStyle} />;
                          })}
                          {/* 삭제 (행 삭제는 없음, 서브행에서 등급 삭제) */}
                          <div className="shrink-0" style={{ width: ACTION_W }} />
                        </div>

                        {/* 확장된 서브행 (등급별 인라인 편집) */}
                        {isExpanded && group.zones.map((zone) => {
                          const startVal = getZoneValue(zone, 'schedule_start') || '';
                          const cleanVal = getZoneValue(zone, 'clean_grade') || '';
                          const subStats = zoneStats(zone);
                          return (
                            <div key={zone.id}
                              className="flex items-center text-xs bg-blue-50/40 border-b border-blue-100"
                              style={{ height: 32 }}
                            >
                              <div className="shrink-0" style={{ width: HANDLE_W }} />
                              {colOrder.map(key => {
                                const def = COL_DEFS[key];
                                const isFlex = !!def.flex;
                                const wStyle = isFlex ? { minWidth: def.minWidth } : { width: colWidth(key) };
                                const wClass = isFlex ? 'flex-1 min-w-0' : 'shrink-0';
                                const cell = `flex items-center justify-center h-full ${wClass} border-r border-blue-100`;
                                if (key === 'name') return <div key={key} className={`flex items-center flex-1 min-w-0 px-1 text-gray-500 text-[10px] truncate border-r border-blue-100`} style={{ minWidth: def.minWidth }}>{zone.name}</div>;
                                if (key === 'num') return <div key={key} className={cell} style={wStyle}><span className={`text-[9px] px-1 py-px rounded font-bold ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span></div>;
                                if (key === 'category') return (
                                  <div key={key} className={cell} style={wStyle}>
                                    <select value={getZoneValue(zone, 'category') || group.category} onChange={e => editGroupCategory(group.key, e.target.value)} onClick={e => e.stopPropagation()}
                                      className="text-[10px] border border-gray-200 rounded px-0.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-full max-w-[56px]">
                                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                  </div>
                                );
                                if (key === 'clean_grade') return (
                                  <div key={key} className={cell} style={wStyle}>
                                    <select value={cleanVal} onChange={e => editZoneField(zone.id, 'clean_grade', e.target.value)} onClick={e => e.stopPropagation()}
                                      className="text-[10px] border border-gray-200 rounded px-0.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-full max-w-[60px]">
                                      <option value="">—</option>
                                      {CLEAN_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                                    </select>
                                  </div>
                                );
                                if (key === 'start') return (
                                  <div key={key} className={cell} style={wStyle}>
                                    <input type="date" value={startVal} onChange={e => editZoneField(zone.id, 'schedule_start', e.target.value)} onBlur={() => handleDateBlur(zone)} onClick={e => e.stopPropagation()}
                                      className="text-[10px] border border-gray-200 rounded px-0.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-full" />
                                  </div>
                                );
                                if (key === 'end') return <div key={key} className={`${cell} text-[10px] text-gray-400`} style={wStyle}>{fmtDate(startVal ? subStats.endDate : null)}</div>;
                                if (key === 'dday') return <div key={key} className={`${cell} text-[10px] font-mono ${ddayColor(startVal ? subStats.dday : null, false)}`} style={wStyle}>{startVal ? ddayLabel(subStats.dday) : '—'}</div>;
                                if (POINT_FIELD[key]) {
                                  const val = getZoneValue(zone, POINT_FIELD[key]) ?? '';
                                  return (
                                    <div key={key} className={cell} style={wStyle}>
                                      <input type="number" min="0" max="999" value={val}
                                        onChange={e => editZoneField(zone.id, POINT_FIELD[key], e.target.value === '' ? null : Number(e.target.value))} onClick={e => e.stopPropagation()}
                                        className="text-[10px] border border-gray-200 rounded px-0.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-full max-w-[40px] text-center" />
                                    </div>
                                  );
                                }
                                if (key === 'count') return <div key={key} className={`${cell} text-[10px] font-mono text-gray-400`} style={wStyle}>{subStats.total ? `${subStats.done}/${subStats.total}` : '—'}</div>;
                                if (key === 'progress') return (
                                  <div key={key} className={cell} style={wStyle}>
                                    {subStats.status ? <span className={`text-[9px] px-1.5 py-px rounded font-medium ${STATUS_STYLE[subStats.status]}`}>{subStats.status}</span> : <span className="text-[9px] text-gray-300">—</span>}
                                  </div>
                                );
                                if (key === 'grade') return <div key={key} className={cell} style={wStyle}><span className={`text-[9px] px-1 py-px rounded ${GRADE_COLORS[zone.grade] || 'bg-gray-100 text-gray-600'}`}>{zone.grade}</span></div>;
                                return <div key={key} className={cell} style={wStyle} />;
                              })}
                              {/* 삭제 버튼 */}
                              <div className="shrink-0 flex items-center justify-center" style={{ width: ACTION_W }}>
                                <button
                                  onClick={e => { e.stopPropagation(); handleDeleteZoneGrade(group.key, zone.id); }}
                                  className="text-gray-300 hover:text-red-500 text-xs leading-none"
                                  title="이 등급 삭제"
                                >✕</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {filteredGroups.length === 0 && (
                    <div className="text-center py-10 text-sm text-gray-400">
                      {folderFilter !== null ? '이 폴더에 속한 구역이 없습니다' : '구역이 없습니다'}
                    </div>
                  )}
                </div>
              </div>

              {/* 오른쪽: 폴더 패널 */}
              <div className="shrink-0 border-l border-gray-200 flex flex-col" style={{ width: 160 }}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200 shrink-0">일정그룹 (폴더)</div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {/* 전체 */}
                  <div
                    onClick={() => setFolderFilter(null)}
                    onDragOver={e => { e.preventDefault(); setDragOverFolder('__all__'); }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={e => { e.preventDefault(); setDragOverFolder(null); }}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${folderFilter === null ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-blue-50 hover:border-blue-200'}`}
                  >
                    <span>📂</span>
                    <span className="font-medium flex-1">전체</span>
                    <span className={`shrink-0 text-[10px] ${folderFilter === null ? 'text-blue-200' : 'text-gray-400'}`}>{modalGroups.length}</span>
                  </div>
                  {/* 그룹 없음 */}
                  <div
                    onClick={() => setFolderFilter('__none__')}
                    onDragOver={e => { e.preventDefault(); setDragOverFolder('__none__'); }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={e => handleFolderDrop(e, '')}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${folderFilter === '__none__' ? 'bg-blue-100 border-blue-400 text-blue-700' : dragOverFolder === '__none__' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                  >
                    <span>📁</span>
                    <span className="flex-1">그룹 없음</span>
                    <span className="shrink-0 text-[10px] text-gray-400">{ungroupedCount()}</span>
                  </div>
                  {/* 폴더 목록 */}
                  {modalNamedGroups.map(g => (
                    <div
                      key={g.id}
                      onClick={() => setFolderFilter(String(g.id))}
                      onDragOver={e => { e.preventDefault(); setDragOverFolder(String(g.id)); }}
                      onDragLeave={() => setDragOverFolder(null)}
                      onDrop={e => handleFolderDrop(e, String(g.id))}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${folderFilter === String(g.id) ? 'bg-blue-600 text-white border-blue-600' : dragOverFolder === String(g.id) ? 'bg-blue-100 border-blue-400 text-blue-700' : 'bg-white border-gray-200 text-gray-700 hover:bg-blue-50 hover:border-blue-200'}`}
                    >
                      <span>📁</span>
                      <span className="font-medium truncate flex-1">{g.name}</span>
                      <span className={`shrink-0 text-[10px] ${folderFilter === String(g.id) ? 'text-blue-200' : 'text-gray-400'}`}>{folderZoneCount(g)}</span>
                    </div>
                  ))}
                  {/* 새 폴더 */}
                  {showNewFolder ? (
                    <div className="space-y-1 pt-1">
                      <input
                        autoFocus
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="폴더명"
                        value={newFolderName}
                        onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') addNewFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
                      />
                      <div className="flex gap-1">
                        <button onClick={addNewFolder} disabled={!newFolderName.trim()} className="flex-1 text-xs py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">만들기</button>
                        <button onClick={() => { setShowNewFolder(false); setNewFolderName(''); }} className="flex-1 text-xs py-0.5 border border-gray-200 rounded text-gray-500 hover:bg-gray-50">취소</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowNewFolder(true)} className="w-full flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border border-dashed border-gray-300 text-gray-400 hover:bg-gray-50 hover:border-gray-400 hover:text-gray-600 transition-colors">
                      <span>+</span><span>새 폴더</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 상태 표시줄 */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-t border-gray-200 shrink-0">
              <span className="text-xs text-gray-500 truncate">
                {modalSelectedIdx !== null
                  ? `"${filteredGroups[modalSelectedIdx]?.name}" 선택 — 버튼·≡ 드래그로 이동 / 폴더에 드래그하여 그룹 배정 / 우클릭으로 그룹 배정`
                  : '구역 클릭 선택 후 이동, ≡ 드래그로 순서 변경, 우클릭으로 그룹 배정'}
              </span>
              <div className="flex gap-2 shrink-0">
                <button onClick={saveOrderModal} disabled={saving} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">{saving ? '저장 중…' : '저장'}</button>
                <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-100 transition-colors">닫기</button>
              </div>
            </div>
          </>
        ) : (
          /* ─── 측정주기 설정 탭 ─── */
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-gray-100 shrink-0 flex-wrap">
              {categories.map(cat => (
                <button key={cat} onClick={() => setCycleCatTab(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${cycleCatTab === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                >{cat}</button>
              ))}
              <div className="flex-1" />
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
            </div>
            <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
              <p className="text-xs text-gray-400">등급별 측정 횟수·간격을 설정합니다. 변경 시 달력 일정이 즉시 재계산됩니다.</p>
              <div className="flex gap-2">
                {!BUILTIN_CATS.includes(cycleCatTab) && (
                  <button onClick={() => removeCycleCategory(cycleCatTab)} className="text-xs px-2 py-1 bg-red-50 text-red-500 rounded hover:bg-red-100">분류 삭제</button>
                )}
                <button onClick={() => resetCycleCategory(cycleCatTab)} className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-gray-200">기본값</button>
              </div>
            </div>
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
                        // 구형 데이터 호환 — unit 없으면 표시용으로 변환
                        const unit = phase.unit || (
                          phase.type === 'monthly' ? 'month' :
                          phase.type === 'quarterly' ? 'month' :
                          phase.type === 'weekly' ? 'week' :
                          phase.type === 'biweekly' ? 'week' : 'day'
                        );
                        const interval = phase.interval ?? (
                          phase.type === 'quarterly' ? 3 :
                          phase.type === 'biweekly' ? 2 :
                          phase.intervalDays ?? 1
                        );
                        return (
                          <div key={idx} className="flex items-center gap-2 px-3 py-2 flex-wrap">
                            <span className="text-[10px] text-gray-300 w-4 shrink-0">{idx + 1}</span>
                            {/* 간격 숫자 */}
                            <div className="flex items-center gap-1">
                              <input type="number" min="1" max="365" value={interval}
                                onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'interval', e.target.value)}
                                className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                              {/* 단위 */}
                              <select value={unit}
                                onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'unit', e.target.value)}
                                className="text-xs border border-gray-200 rounded px-1 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                                {CYCLE_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                              <span className="text-xs text-gray-400">간격</span>
                            </div>
                            {/* 횟수 */}
                            <div className="flex items-center gap-1">
                              <input type="number" min="1" max="999" value={phase.count}
                                onChange={e => editCyclePhase(cycleCatTab, grade, idx, 'count', e.target.value)}
                                className="w-12 text-xs border border-gray-200 rounded px-1 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                              <span className="text-xs text-gray-400">회</span>
                            </div>
                            <button onClick={() => removeCyclePhase(cycleCatTab, grade, idx)} className="ml-auto text-xs text-gray-300 hover:text-red-500 shrink-0" title="삭제">✕</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 bg-gray-50 border-t border-gray-200 shrink-0">
              <span className="text-xs text-gray-400 mr-auto">측정주기는 변경 즉시 저장됩니다</span>
              <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-100 transition-colors">닫기</button>
            </div>
          </div>
        )}

        {/* 크기 조절 핸들 */}
        {!docked && (
          <div onMouseDown={startResize} className="absolute bottom-0 right-0 cursor-se-resize" style={{ width: 16, height: 16 }}>
            <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
              <path d="M16 4L4 16" stroke="#9ca3af" strokeWidth="1.5" />
              <path d="M16 9L9 16" stroke="#9ca3af" strokeWidth="1.5" />
              <path d="M16 14L14 16" stroke="#9ca3af" strokeWidth="1.5" />
            </svg>
          </div>
        )}

        {error && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg text-xs z-10 flex items-center gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-200 hover:text-white">✕</button>
          </div>
        )}
      </div>

      {/* 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-white rounded-xl shadow-2xl border border-gray-200 py-1 z-[600] min-w-36"
          style={{ left: contextMenu.x, top: contextMenu.y, pointerEvents: 'auto' }}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">📁 그룹 배정</div>
          <button
            onClick={() => { modalAssignGroup(contextMenu.groupIdx, ''); setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >그룹 없음</button>
          {modalNamedGroups.map(g => (
            <button
              key={g.id}
              onClick={() => { modalAssignGroup(contextMenu.groupIdx, String(g.id)); setContextMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700"
            >
              📁 {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
