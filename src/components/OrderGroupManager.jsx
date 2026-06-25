import { useState, useEffect, useRef, useMemo } from 'react';
import { upsertZone, upsertGroup, fetchScheduleConfig, saveScheduleConfig } from '../lib/api';
import { GRADE_PRIORITY, DEFAULT_SCHEDULE_SPECS, setScheduleConfig, getScheduleConfig } from '../lib/schedule';
import { GRADE_COLORS } from '../data/initialData';

const CYCLE_TYPES = [
  { value: 'daily',     label: '매일(일1회)' },
  { value: 'weekly',    label: '주1회' },
  { value: 'biweekly',  label: '격주(2주)' },
  { value: 'monthly',   label: '월1회' },
  { value: 'quarterly', label: '분기1회(3개월)' },
];
const DEFAULT_INTERVAL = { daily: 1, weekly: 7, biweekly: 14 };
const CYCLE_GRADES = ['P1', 'P2', 'P3', '유지관리'];
const BUILTIN_CATS = ['공조', '압축공기', '질소가스'];

function groupOrderKey(g) {
  return Math.min(...g.zones.map(z => (typeof z.sort_order === 'number' ? z.sort_order : 1e9)));
}

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
  arr.sort((a, b) => (groupOrderKey(a) - groupOrderKey(b)) || a.name.localeCompare(b.name));
  return arr;
}

/**
 * 구역 순서 / 그룹(폴더) 관리 + 측정주기 설정 통합 팝업.
 * 월별 환경모니터링의 순서/그룹 관리 기능을 달력보기에서도 쓸 수 있도록 분리한 공용 컴포넌트.
 *
 * props:
 *  - zones, groups: 현재 데이터
 *  - onClose(): 닫기
 *  - onSaved(updatedZones, updatedGroups, cycleConfig): 저장 후 부모 데이터 갱신
 */
export default function OrderGroupManager({ zones, groups, onClose, onSaved }) {
  const [activeTab, setActiveTab] = useState('order'); // 'order' | 'cycle'
  const [modalGroups, setModalGroups] = useState(() => buildOrderedGroups(zones).map(g => ({ ...g, zones: [...g.zones] })));
  const [modalNamedGroups, setModalNamedGroups] = useState(() => groups.map(g => ({ ...g, zoneIds: [...(g.zoneIds || [])] })));
  const [modalSelectedIdx, setModalSelectedIdx] = useState(null);
  const [pos, setPos] = useState({ x: 80, y: 60 });
  const [size, setSize] = useState({ w: 840, h: 560 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  // 측정주기 설정
  const [cycleConfig, setCycleConfig] = useState(() => getScheduleConfig());
  const [cycleCatTab, setCycleCatTab] = useState(() => Object.keys(getScheduleConfig())[0] || '공조');
  const [newCatName, setNewCatName] = useState('');

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

  // ─── 순서 이동 ──────────────────────────────────────────────
  function moveModalSelected(dir) {
    if (modalSelectedIdx === null) return;
    const arr = [...modalGroups];
    let newIdx;
    if (dir === 'top')         newIdx = 0;
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
    setSaving(true);
    try {
      const zoneUpdates = [];
      modalGroups.forEach((g, gi) => {
        g.zones.forEach((z, zi) => {
          zoneUpdates.push({ ...z, sort_order: gi * 1000 + zi });
        });
      });
      for (const u of zoneUpdates) await upsertZone(u);
      for (const g of modalNamedGroups) await upsertGroup(g);
      const updatedZones = zones.map(z => zoneUpdates.find(u => u.id === z.id) || z);
      onSaved?.(updatedZones, modalNamedGroups, cycleConfig);
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
    const onMove = ev => setSize({ w: Math.max(580, startW + ev.clientX - startX), h: Math.max(360, startH + ev.clientY - startY) });
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
    if (BUILTIN_CATS.includes(cat)) return;
    const next = JSON.parse(JSON.stringify(cycleConfig));
    delete next[cat];
    applyCycleConfig(next);
    setCycleCatTab(Object.keys(next)[0] || '공조');
  }

  return (
    <div className="fixed inset-0 z-[500]" style={{ pointerEvents: 'none' }}>
      <div
        className="absolute flex flex-col bg-white rounded-xl overflow-hidden"
        style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, pointerEvents: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.30)', border: '1px solid #e5e7eb' }}
      >
        {/* 헤더 */}
        <div onMouseDown={startDrag} className="flex items-center justify-between px-4 bg-gray-900 text-white cursor-move shrink-0" style={{ height: 46 }}>
          <div className="flex items-center gap-2">
            <svg width="16" height="14" viewBox="0 0 16 13" fill="none">
              <rect width="16" height="10" rx="1.5" fill="#fbbf24" y="2.5" />
              <rect width="7" height="2.5" fill="#f59e0b" y="0.5" x="0.5" rx="1" />
            </svg>
            <span className="font-semibold text-sm">구역 순서 / 그룹 · 측정주기 관리</span>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 text-gray-400 hover:text-white text-sm transition-colors">✕</button>
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
                { dir: 'down1',  label: '아래로',   icon: '▼',  dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
                { dir: 'down10', label: '10아래',   icon: '▼▼', dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
                { dir: 'bottom', label: '맨아래로', icon: '⏬', dis: modalSelectedIdx === null || modalSelectedIdx >= modalGroups.length - 1 },
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

            {/* 두 패널 */}
            <div className="flex flex-1 min-h-0">
              {/* 왼쪽: 구역 목록 */}
              <div className="flex flex-col flex-1 min-w-0">
                <div className="flex items-center bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 shrink-0" style={{ height: 28 }}>
                  <div className="w-8 text-center shrink-0 text-gray-300">≡</div>
                  <div className="w-8 text-center shrink-0">#</div>
                  <div className="flex-1 pl-1">구역명</div>
                  <div className="text-center shrink-0" style={{ width: 68 }}>분류</div>
                  <div className="text-center shrink-0" style={{ width: 96 }}>등급</div>
                </div>
                <div ref={listRef} className="flex-1 overflow-y-auto">
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

              {/* 오른쪽: 폴더 패널 */}
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
                      <span className="text-gray-400 shrink-0">{(g.zoneIds || []).length}</span>
                    </div>
                  ))}
                  {showNewFolder ? (
                    <div className="space-y-1">
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
                    <button onClick={() => setShowNewFolder(true)} className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs border border-dashed border-gray-300 text-gray-400 hover:bg-gray-50 hover:border-gray-400 hover:text-gray-600 transition-colors">
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
                  ? `"${modalGroups[modalSelectedIdx]?.name}" 선택 — 버튼·≡ 드래그로 이동 / 폴더에 드래그하여 그룹 배정`
                  : '구역 클릭 선택 후 이동, 또는 ≡ 핸들을 드래그하여 순서 변경'}
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
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 bg-gray-50 border-t border-gray-200 shrink-0">
              <span className="text-xs text-gray-400 mr-auto">측정주기는 변경 즉시 저장됩니다</span>
              <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-100 transition-colors">닫기</button>
            </div>
          </div>
        )}

        {/* 크기 조절 핸들 */}
        <div onMouseDown={startResize} className="absolute bottom-0 right-0 cursor-se-resize" style={{ width: 16, height: 16 }}>
          <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
            <path d="M16 4L4 16" stroke="#9ca3af" strokeWidth="1.5" />
            <path d="M16 9L9 16" stroke="#9ca3af" strokeWidth="1.5" />
            <path d="M16 14L14 16" stroke="#9ca3af" strokeWidth="1.5" />
          </svg>
        </div>

        {error && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg text-xs z-10 flex items-center gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-200 hover:text-white">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}
